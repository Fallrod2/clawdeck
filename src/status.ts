// src/status.ts — sondes de production et payload partagé du health panel.

import { env } from "./env";
import { checkGateway, checkOllama, type HttpCheckResult, type OllamaCheckResult } from "./checks";
import { insertPing } from "./db";
import { detectDefaultGateway, ping, type PingResult } from "./network";
import type { OpenClawRuntimeStatus } from "./openclaw-status";

const CLOUDFLARE_HOST = "1.1.1.1";
const DEFAULT_ORANGE_GATEWAY = "192.168.1.1";
// Site distant supervisé à la demande (IP fixe, hors du LAN local) : même
// traitement qu'une cible externe fixe (voir CLOUDFLARE_HOST).
const REMOTE_HOST = "83.204.110.38";

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
}

export async function collectStatus(
  openclaw: OpenClawRuntimeStatus,
): Promise<StatusPayload> {
  const orangeGatewayIp =
    env.orangeGatewayIp ??
    (await detectDefaultGateway()) ??
    DEFAULT_ORANGE_GATEWAY;

  const [gateway, ollama, cloudflarePing, orangePing, remotePing] = await Promise.all([
    checkGateway(env.gatewayUrl),
    checkOllama(env.ollamaUrl, env.ollamaFallbackModel),
    ping(CLOUDFLARE_HOST),
    ping(orangeGatewayIp),
    ping(REMOTE_HOST),
  ]);

  insertPing("cloudflare", CLOUDFLARE_HOST, cloudflarePing.ok, cloudflarePing.latencyMs);
  insertPing("orange", orangeGatewayIp, orangePing.ok, orangePing.latencyMs);
  insertPing("remote", REMOTE_HOST, remotePing.ok, remotePing.latencyMs);

  return {
    timestamp: Date.now(),
    gateway,
    openclaw,
    ollama,
    ping: {
      cloudflare: { host: CLOUDFLARE_HOST, ...cloudflarePing },
      orange: { host: orangeGatewayIp, ...orangePing },
      remote: { host: REMOTE_HOST, ...remotePing },
    },
  };
}
