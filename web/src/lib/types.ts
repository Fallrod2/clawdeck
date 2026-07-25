// src/lib/types.ts — types miroir du payload backend.
// Source de vérité : ../../../src/status.ts (SSE /api/status) et ../../../src/db.ts (historique).

export interface HttpCheck {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface OllamaCheck extends HttpCheck {
  models?: string[];
  fallbackModelReady?: boolean;
}

export interface PingCheck {
  host: string;
  ok: boolean;
  latencyMs: number | null;
}

export interface OpenClawRuntimeStatus {
  connected: boolean;
  healthy: boolean | null;
  version: string | null;
  uptimeMs: number | null;
  healthTimestamp: number | null;
  healthDurationMs: number | null;
  provider: string | null;
  model: string | null;
  configuredModel: string | null;
  usingFallback: boolean | null;
  modelAvailable: boolean | null;
  whatsapp: {
    configured: boolean | null;
    linked: boolean | null;
    running: boolean | null;
    connected: boolean | null;
    healthy: boolean | null;
    healthState: string | null;
    lastActivityAt: number | null;
    lastError: string | null;
  };
  error?: string;
}

// Conclusion réseau calculée par le backend (src/network-diagnosis.ts) : le
// front ne la recalcule pas, il la RESTITUE. Distinguer une coupure locale
// d'une coupure en amont est une décision, elle appartient à un endroit
// unique et testable.
export interface NetworkDiagnosis {
  severity: "good" | "warning" | "critical";
  headline: string;
  detail: string;
}

// Journal des anomalies récentes, tenu EN MÉMOIRE par le backend
// (src/anomalies.ts) et rediffusé dans chaque instantané : le front ne détecte
// aucune transition lui-même, il n'en verrait que celles survenues pendant
// qu'un onglet était ouvert. Il ne fait donc que restituer — y compris la
// fenêtre réellement observée, que `since` et `retentionMs` permettent
// d'annoncer sans laisser croire à un historique complet.
export interface AnomalyEntry {
  key: string;
  scope: string;
  severity: "warning" | "critical";
  label: string;
  detail: string;
  startedAt: number;
  lastSeenAt: number;
  /** null tant que l'anomalie est encore observée. */
  endedAt: number | null;
  /** Survenues regroupées sous cette entrée (1 = incident continu). */
  occurrences: number;
}

export interface AnomalyJournal {
  /** Début d'observation = démarrage du backend. */
  since: number;
  retentionMs: number;
  entries: AnomalyEntry[];
}

export interface StatusPayload {
  timestamp: number;
  gateway: HttpCheck;
  openclaw?: OpenClawRuntimeStatus;
  ollama: OllamaCheck;
  ping: {
    cloudflare: PingCheck;
    orange: PingCheck;
    remote: PingCheck;
  };
  // Optionnel : un backend plus ancien que ce front n'en émet pas, l'interface
  // affiche alors « Diagnostic en attente » plutôt que de planter.
  network?: NetworkDiagnosis;
  // Optionnel pour la même raison. Le front servi depuis le disque se met à
  // jour d'un simple build, sans redémarrer le backend : les deux versions se
  // croisent régulièrement en exploitation.
  anomalies?: AnomalyJournal;
}

export interface PingRow {
  ts: number;
  ok: number;
  latencyMs: number | null;
}

export interface PingHistory {
  bucketMs: number;
  cloudflare: PingRow[];
  orange: PingRow[];
  remote: PingRow[];
}
