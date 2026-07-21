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
