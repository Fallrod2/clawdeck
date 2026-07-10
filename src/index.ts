// src/index.ts — backend Hono : health panel SSE + historique des pings.
// Sert aussi le front buildé (web/dist) en production (voir CLAUDE.md).

import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { WSContext } from "hono/ws";
import { env } from "./env";
import { checkGateway, checkOllama } from "./checks";
import { ping, detectDefaultGateway } from "./network";
import { insertPing, pruneOldPings, getPingHistoryBucketed } from "./db";
import { GatewayClient } from "./gateway/client";

const CLOUDFLARE_HOST = "1.1.1.1";
const POLL_INTERVAL_MS = 5000;
const DEFAULT_ORANGE_GATEWAY = "192.168.1.1";

const app = new Hono();

// Auth bearer sur toute l'API (token depuis .env, jamais commité).
// Exception : /api/chat/ws, dont le handshake WS ne peut pas poser de header
// (voir plus bas, auth par première frame à la place).
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/chat/ws") {
    await next();
    return;
  }
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== env.authToken) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

async function collectStatus() {
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
    ollama,
    ping: {
      cloudflare: { host: CLOUDFLARE_HOST, ...cloudflarePing },
      orange: { host: orangeGatewayIp, ...orangePing },
    },
  };
}

// Stream l'état complet toutes les 5s.
app.get("/api/status", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    while (!closed) {
      try {
        const payload = await collectStatus();
        await stream.writeSSE({ data: JSON.stringify(payload), event: "status" });
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({ error: (err as Error).message }),
          event: "error",
        });
      }
      if (!closed) await stream.sleep(POLL_INTERVAL_MS);
    }
  });
});

// Historique des pings pour le graphe de latence (7j max, voir db.ts).
// Agrégé en ~360 points côté SQL quel que soit l'intervalle demandé.
app.get("/api/pings/history", (c) => {
  const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 24), 1), 24 * 7);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const bucketMs = Math.max(5000, Math.round((hours * 60 * 60 * 1000) / 360));
  return c.json({
    bucketMs,
    cloudflare: getPingHistoryBucketed("cloudflare", since, bucketMs),
    orange: getPingHistoryBucketed("orange", since, bucketMs),
  });
});

// Rétention 7 jours (voir RETENTION_MS dans db.ts).
pruneOldPings();
setInterval(pruneOldPings, 60 * 60 * 1000);

// --- Chat (phase 2) : relais WS entre le front et la gateway OpenClaw ---
// Le dashboard ne maintient qu'UNE connexion vers la gateway (auth par
// identité d'appareil, voir gateway/client.ts) et la relaie à tous les
// clients navigateur authentifiés — cohérent avec l'auth bearer du reste
// de l'API, un navigateur ne pouvant pas poser de header sur un handshake WS.
const gateway = new GatewayClient(env.gatewayWsUrl, env.gatewayAuthToken, env.gatewayDeviceIdentityPath);
gateway.start();

const chatClients = new Set<WSContext>();
const AUTH_TIMEOUT_MS = 5000;

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of chatClients) {
    try {
      ws.send(data);
    } catch {
      // client probablement déjà fermé ; nettoyé par onClose
    }
  }
}

gateway.on("status", (status: { connected: boolean; error?: string }) => {
  broadcast({ type: "gateway-status", ...status });
});
gateway.on("chat", (payload: unknown) => broadcast({ type: "chat", payload }));
gateway.on("agent", (payload: unknown) => broadcast({ type: "agent", payload }));
gateway.on("session-message", (payload: unknown) => broadcast({ type: "session-message", payload }));

app.get(
  "/api/chat/ws",
  upgradeWebSocket(() => {
    let authed = false;
    let authTimer: ReturnType<typeof setTimeout> | null = null;

    return {
      onOpen(_evt, ws) {
        authTimer = setTimeout(() => {
          if (!authed) ws.close(1008, "auth timeout");
        }, AUTH_TIMEOUT_MS);
      },
      onMessage(evt, ws) {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(evt.data as string);
        } catch {
          return;
        }

        if (!authed) {
          if (msg.type === "auth" && msg.token === env.authToken) {
            authed = true;
            if (authTimer) clearTimeout(authTimer);
            chatClients.add(ws);
            ws.send(JSON.stringify({ type: "auth-ok" }));
            ws.send(JSON.stringify({ type: "gateway-status", connected: gateway.isConnected }));
            gateway.getHistory().then((messages) => {
              ws.send(JSON.stringify({ type: "history", messages }));
            });
          } else {
            ws.close(1008, "unauthorized");
          }
          return;
        }

        if (msg.type === "send" && typeof msg.text === "string" && msg.text.trim()) {
          gateway.sendChatMessage(msg.text.trim()).catch((err: Error) => {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          });
        }
      },
      onClose(_evt, ws) {
        if (authTimer) clearTimeout(authTimer);
        chatClients.delete(ws);
      },
    };
  }),
);

// Sert le front buildé (`bun run build`). En dev, Vite tourne à part (voir dev.ts)
// et proxy /api vers ce backend.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

console.log(`clawdeck backend → http://${env.bindHost}:${env.port}`);

export default {
  port: env.port,
  hostname: env.bindHost,
  fetch: app.fetch,
  websocket,
};
