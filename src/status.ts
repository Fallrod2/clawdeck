// src/status.ts — sondes de production et payload partagé du health panel.

import { getEnv } from "./env";
import { createAnomalyJournal, type AnomalyJournalPayload } from "./anomalies";
import { checkGateway, checkOllama, type HttpCheckResult, type OllamaCheckResult } from "./checks";
import { insertPing } from "./db";
import {
  detectDefaultGateway,
  ping,
  reportDefaultGatewayProbe,
  type PingResult,
} from "./network";
import { diagnoseNetwork, type NetworkDiagnosis } from "./network-diagnosis";
import type { OpenClawRuntimeStatus } from "./openclaw-status";

const CLOUDFLARE_HOST = "1.1.1.1";
const DEFAULT_ORANGE_GATEWAY = "192.168.1.1";
// Site distant supervisé à la demande (IP fixe, hors du LAN local) : même
// traitement qu'une cible externe fixe (voir CLOUDFLARE_HOST).
const REMOTE_HOST = "83.204.110.38";

// Journal des anomalies, EN MÉMOIRE et borné (voir anomalies.ts) : rien n'est
// écrit sur disque, la liste repart vide au démarrage et le payload transporte
// sa fenêtre d'observation pour le dire. L'état vit ici, à côté du cache de
// passerelle de network.ts, parce que la détection d'une transition exige de
// comparer deux cycles — et que ce module est le seul point de passage de
// TOUS les cycles, ouvert ou non dans un navigateur.
const anomalyJournal = createAnomalyJournal();

export interface StatusPayload {
  timestamp: number;
  gateway: HttpCheckResult;
  openclaw: OpenClawRuntimeStatus;
  ollama: OllamaCheckResult;
  ping: {
    cloudflare: PingResult & { host: string };
    orange: PingResult & { host: string };
    remote: PingResult & { host: string };
  };
  // Conclusion opérationnelle des trois sondes ci-dessus : trois pastilles
  // rouges ne disent pas si la panne est locale ou en amont (network-diagnosis.ts).
  network: NetworkDiagnosis;
  // Ce qui a lâché récemment, même revenu au vert depuis. Voyage avec chaque
  // instantané : un navigateur qui se reconnecte retrouve le journal sans
  // requête supplémentaire ni réconciliation.
  anomalies: AnomalyJournalPayload;
}

export async function collectStatus(
  openclaw: OpenClawRuntimeStatus,
): Promise<StatusPayload> {
  const orangeGatewayIp =
    getEnv().orangeGatewayIp ??
    (await detectDefaultGateway()) ??
    DEFAULT_ORANGE_GATEWAY;

  const [gateway, ollama, cloudflarePing, orangePing, remotePing] = await Promise.all([
    checkGateway(getEnv().gatewayUrl),
    checkOllama(getEnv().ollamaUrl, getEnv().ollamaFallbackModel),
    ping(CLOUDFLARE_HOST),
    ping(orangeGatewayIp),
    ping(REMOTE_HOST),
  ]);

  // Boucle de retour vers la détection : c'est ce qui fait tomber le cache de
  // passerelle quand la route par défaut a bougé, au lieu de sonder
  // indéfiniment une adresse abandonnée (voir network.ts).
  reportDefaultGatewayProbe(orangeGatewayIp, orangePing.ok);

  insertPing("cloudflare", CLOUDFLARE_HOST, cloudflarePing.ok, cloudflarePing.latencyMs);
  insertPing("orange", orangeGatewayIp, orangePing.ok, orangePing.latencyMs);
  insertPing("remote", REMOTE_HOST, remotePing.ok, remotePing.latencyMs);

  const measured = {
    timestamp: Date.now(),
    gateway,
    openclaw,
    ollama,
    ping: {
      cloudflare: { host: CLOUDFLARE_HOST, ...cloudflarePing },
      orange: { host: orangeGatewayIp, ...orangePing },
      remote: { host: REMOTE_HOST, ...remotePing },
    },
    network: diagnoseNetwork({
      local: { host: orangeGatewayIp, ok: orangePing.ok },
      internet: { host: CLOUDFLARE_HOST, ok: cloudflarePing.ok },
      remote: { host: REMOTE_HOST, ok: remotePing.ok },
    }),
  };

  // Horodaté par la MESURE et non par l'instant du pliage : une anomalie porte
  // l'heure à laquelle elle a été constatée.
  return { ...measured, anomalies: anomalyJournal.observe(measured, measured.timestamp) };
}
