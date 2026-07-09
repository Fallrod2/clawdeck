// src/index.ts — backend Hono : health panel SSE + historique des pings.
// Sert aussi le front buildé (web/dist) en production (voir CLAUDE.md).

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { env } from "./env";
import { checkGateway, checkOllama } from "./checks";
import { ping, detectDefaultGateway } from "./network";
import { insertPing, pruneOldPings, getPingHistoryBucketed } from "./db";

const CLOUDFLARE_HOST = "1.1.1.1";
const POLL_INTERVAL_MS = 5000;
const DEFAULT_ORANGE_GATEWAY = "192.168.1.1";

const app = new Hono();

// Auth bearer sur toute l'API (token depuis .env, jamais commité).
app.use("/api/*", async (c, next) => {
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

// Sert le front buildé (`bun run build`). En dev, Vite tourne à part (voir dev.ts)
// et proxy /api vers ce backend.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

console.log(`clawdeck backend → http://${env.bindHost}:${env.port}`);

export default {
  port: env.port,
  hostname: env.bindHost,
  fetch: app.fetch,
};
