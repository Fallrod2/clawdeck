// src/env.ts — chargement et validation des variables d'environnement.
// Bun charge .env automatiquement ; voir .env.example pour la liste complète.
// Ne jamais commiter .env (voir .gitignore).

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante: ${name} (voir .env.example)`,
    );
  }
  return value;
}

const bindHost = process.env.BIND_HOST ?? "127.0.0.1";

// Règle d'architecture (CLAUDE.md) : jamais de bind sur toutes les interfaces.
if (bindHost === "0.0.0.0") {
  throw new Error(
    "BIND_HOST ne doit jamais être 0.0.0.0 — utiliser 127.0.0.1 ou l'IP Tailscale (voir CLAUDE.md).",
  );
}

const gatewayUrl = required("GATEWAY_URL");

export const env = {
  port: Number(process.env.PORT ?? 3001),
  bindHost,
  authToken: required("AUTH_TOKEN"),
  gatewayUrl,
  // WS de la gateway OpenClaw (chat) : même host/port que GATEWAY_URL, en ws://.
  gatewayWsUrl: gatewayUrl.replace(/^http/, "ws").replace(/\/?$/, "/"),
  // Token partagé de la gateway (gateway.auth.token dans ~/.openclaw/openclaw.json),
  // distinct de notre propre AUTH_TOKEN.
  gatewayAuthToken: required("GATEWAY_AUTH_TOKEN"),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  ollamaFallbackModel: process.env.OLLAMA_FALLBACK_MODEL ?? "qwen3.5:9b",
  // Si vide, auto-détectée via `route -n get default` (voir network.ts).
  orangeGatewayIp: process.env.ORANGE_GATEWAY_IP || null,
  dbPath: process.env.DB_PATH ?? "./data/clawdeck.sqlite",
  gatewayDeviceIdentityPath: process.env.GATEWAY_DEVICE_IDENTITY_PATH ?? "./data/gateway-device-identity.json",
};
