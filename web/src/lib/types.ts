// src/lib/types.ts — types miroir du payload backend.
// Source de vérité : ../../../src/index.ts (SSE /api/status) et ../../../src/db.ts (historique).

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

export interface StatusPayload {
  timestamp: number;
  gateway: HttpCheck;
  ollama: OllamaCheck;
  ping: {
    cloudflare: PingCheck;
    orange: PingCheck;
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
}
