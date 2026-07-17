// src/status.ts — sondes de production et payload partagé du health panel.

import { env } from "./env";
import { checkGateway, checkOllama, type HttpCheckResult, type OllamaCheckResult } from "./checks";
import { insertPing } from "./db";
import { detectDefaultGateway, ping, type PingResult } from "./network";
import type { OpenClawRuntimeStatus } from "./openclaw-status";

const CLOUDFLARE_HOST = "1.1.1.1";
const DEFAULT_ORANGE_GATEWAY = "192.168.1.1";

export interface StatusPayload {
  timestamp: number;
  gateway: HttpCheckResult;
  openclaw: OpenClawRuntimeStatus;
  ollama: OllamaCheckResult;
  ping: {
    cloudflare: PingResult & { host: string };
    orange: PingResult & { host: string };
  };
}

export async function collectStatus(
  openclaw: OpenClawRuntimeStatus,
): Promise<StatusPayload> {
  const orangeGatewayIp =
    env.orangeGatewayIp ??
    (await detectDefaultGateway()) ??
    DEFAULT_ORANGE_GATEWAY;

  const [gateway, ollama, cloudflarePing, orangePing] = await Promise.all([
    checkGateway(env.gatewayUrl),
    checkOllama(env.ollamaUrl, env.ollamaFallbackModel),
    ping(CLOUDFLARE_HOST),
    ping(orangeGatewayIp),
  ]);

  insertPing("cloudflare", CLOUDFLARE_HOST, cloudflarePing.ok, cloudflarePing.latencyMs);
  insertPing("orange", orangeGatewayIp, orangePing.ok, orangePing.latencyMs);

  return {
    timestamp: Date.now(),
    gateway,
    openclaw,
    ollama,
    ping: {
      cloudflare: { host: CLOUDFLARE_HOST, ...cloudflarePing },
      orange: { host: orangeGatewayIp, ...orangePing },
    },
  };
}
