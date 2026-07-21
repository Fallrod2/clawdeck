// src/index.ts — backend Hono : health panel SSE + historique des pings.
// Sert aussi le front buildé (web/dist) en production (voir CLAUDE.md).

import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { WSContext } from "hono/ws";
import { env } from "./env";
import { safeTokenEqual, parseHours, MAX_CHAT_TEXT_LENGTH } from "./validate";
import { closeDatabase, pruneOldPings, getPingHistoryBucketed } from "./db";
import { GatewayClient } from "./gateway/client";
import { collectStatus, type StatusPayload } from "./status";
import { StatusCollector } from "./status-collector";
import { LogTailer } from "./log-tailer";
import { normalizeLogTail, type DashboardLogEntry } from "./logs";
import { saveWorkspaceFile, WorkspaceWriteError } from "./workspace";
import {
  readOpenClawRuntime,
  unavailableOpenClawRuntime,
} from "./openclaw-status";

const POLL_INTERVAL_MS = 5000;

const app = new Hono();
const gateway = new GatewayClient(env.gatewayWsUrl, env.gatewayAuthToken, env.gatewayDeviceIdentityPath);
const logTailer = new LogTailer(gateway);
const openclawCollector = new StatusCollector(() => readOpenClawRuntime(gateway), {
  intervalMs: 15_000,
  onError: (error) => console.error(`[openclaw] collection failed: ${error.message}`),
});
const statusCollector = new StatusCollector(() => collectStatus(
  gateway.isConnected
    ? openclawCollector.current ?? unavailableOpenClawRuntime(gateway, "OpenClaw status pending")
    : unavailableOpenClawRuntime(gateway),
), {
  intervalMs: POLL_INTERVAL_MS,
  onError: (error) => console.error(`[status] collection failed: ${error.message}`),
});

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
  if (!safeTokenEqual(token, env.authToken)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// Chaque client reçoit le dernier snapshot puis les mises à jour de l'unique
// boucle backend. Une connexion SSE ne déclenche jamais elle-même de sonde.
app.get("/api/status", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let pending: StatusPayload | null = null;
    let wake: (() => void) | null = null;

    const unsubscribe = statusCollector.subscribe((snapshot) => {
      // Un client lent ne garde que le snapshot le plus récent.
      pending = snapshot;
      const resolve = wake;
      wake = null;
      resolve?.();
    });

    stream.onAbort(() => {
      closed = true;
      const resolve = wake;
      wake = null;
      resolve?.();
    });

    try {
      while (!closed) {
        if (!pending) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (closed) break;
        const snapshot = pending;
        pending = null;
        if (!snapshot) continue;
        await stream.writeSSE({
          data: JSON.stringify(snapshot),
          event: "status",
        });
      }
    } finally {
      unsubscribe();
    }
  });
});

// Tail borné et redigé par OpenClaw, normalisé puis relayé sans persistance.
app.get("/api/logs", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let pending: DashboardLogEntry[] = [];
    let pendingReset = false;
    let pendingTruncated = false;
    let pendingError: string | null = null;
    let wake: (() => void) | null = null;

    const notify = () => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    const unsubscribe = logTailer.subscribe((event) => {
      if (event.type === "error") {
        pendingError = event.message;
        notify();
        return;
      }
      if (event.result.reset) pending = [];
      pending.push(...normalizeLogTail(event.result));
      if (pending.length > 500) {
        pending = pending.slice(-500);
        pendingTruncated = true;
      }
      pendingReset ||= event.result.reset;
      pendingTruncated ||= event.result.truncated;
      notify();
    });

    stream.onAbort(() => {
      closed = true;
      notify();
    });

    try {
      while (!closed) {
        if (!pending.length && !pendingError && !pendingReset && !pendingTruncated) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (closed) break;
        if (pendingError) {
          const message = pendingError;
          pendingError = null;
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message }),
          });
        }
        if (pending.length || pendingReset || pendingTruncated) {
          const entries = pending;
          const reset = pendingReset;
          const truncated = pendingTruncated;
          pending = [];
          pendingReset = false;
          pendingTruncated = false;
          await stream.writeSSE({
            event: "logs",
            data: JSON.stringify({ entries, reset, truncated }),
          });
        }
      }
    } finally {
      unsubscribe();
    }
  });
});

// Historique des pings pour le graphe de latence (7j max, voir db.ts).
// Agrégé en ~360 points côté SQL quel que soit l'intervalle demandé.
app.get("/api/pings/history", (c) => {
  const hours = parseHours(c.req.query("hours"));
  if (hours === null) {
    return c.json({ error: "invalid hours" }, 400);
  }
  const since = Date.now() - hours * 60 * 60 * 1000;
  const bucketMs = Math.max(5000, Math.round((hours * 60 * 60 * 1000) / 360));
  return c.json({
    bucketMs,
    cloudflare: getPingHistoryBucketed("cloudflare", since, bucketMs),
    orange: getPingHistoryBucketed("orange", since, bucketMs),
    remote: getPingHistoryBucketed("remote", since, bucketMs),
  });
});

// Rétention 7 jours (voir RETENTION_MS dans db.ts).
pruneOldPings();
const pruneTimer = setInterval(pruneOldPings, 60 * 60 * 1000);

// --- Chat (phase 2) : relais WS entre le front et la gateway OpenClaw ---
// Le dashboard ne maintient qu'UNE connexion vers la gateway (auth par
// identité d'appareil, voir gateway/client.ts) et la relaie à tous les
// clients navigateur authentifiés — cohérent avec l'auth bearer du reste
// de l'API, un navigateur ne pouvant pas poser de header sur un handshake WS.

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
  openclawCollector.refresh();
});
gateway.on("chat", (payload: unknown) => broadcast({ type: "chat", payload }));
gateway.on("agent", (payload: unknown) => broadcast({ type: "agent", payload }));
gateway.on("session-message", (payload: unknown) => broadcast({ type: "session-message", payload }));
// Trou de seq sur la connexion gateway : des événements ont pu être manqués,
// on resonde immédiatement l'état OpenClaw.
gateway.on("resync", () => openclawCollector.refresh());

openclawCollector.subscribe(() => statusCollector.refresh());
gateway.start();
openclawCollector.start();
statusCollector.start();

app.get(
  "/api/chat/ws",
  upgradeWebSocket(() => {
    let authed = false;
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    // L'adaptateur Bun de Hono recrée un WSContext à chaque événement : on
    // mémorise l'instance ajoutée à chatClients pour retirer LA MÊME au
    // onClose, sinon le Set fuit un contexte par connexion.
    let registered: WSContext | null = null;

    return {
      onOpen(_evt, ws) {
        authTimer = setTimeout(() => {
          if (!authed) ws.close(1008, "auth timeout");
        }, AUTH_TIMEOUT_MS);
      },
      onMessage(evt, ws) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(evt.data as string);
        } catch {
          return;
        }
        // Frame client typée a minima ; un type inconnu (front plus récent que
        // ce backend) est ignoré silencieusement, jamais une erreur.
        const msg =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        if (!msg) return;

        // Réponse à CE client, seulement s'il est encore vivant. Le readyState
        // du WSContext étant figé à sa création (adaptateur Bun), l'état
        // vivant se lit sur le socket brut — indispensable pour les accusés
        // asynchrones (sendChatMessage/abortRun résolus après coup).
        const reply = (frame: unknown) => {
          if (ws.raw?.readyState !== 1) return;
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            // client fermé entre-temps ; nettoyé par onClose
          }
        };

        if (!authed) {
          if (msg.type === "auth" && safeTokenEqual(msg.token, env.authToken)) {
            authed = true;
            if (authTimer) clearTimeout(authTimer);
            registered = ws;
            chatClients.add(ws);
            ws.send(JSON.stringify({ type: "auth-ok" }));
            ws.send(JSON.stringify({ type: "gateway-status", connected: gateway.isConnected }));
            gateway
              .getHistory()
              .then((messages) => {
                // Le client a pu partir pendant la requête. Le readyState du
                // WSContext étant figé à sa création (adaptateur Bun), l'état
                // vivant se lit sur le socket brut.
                if (ws.raw?.readyState !== 1) return;
                try {
                  ws.send(JSON.stringify({ type: "history", messages }));
                } catch {
                  // client fermé entre-temps ; nettoyé par onClose
                }
              })
              .catch((err) => {
                // Log sobre côté serveur, aucun détail envoyé au client : le
                // chat reste utilisable sans l'historique.
                console.error(
                  `[chat] historique gateway indisponible: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          } else {
            ws.close(1008, "unauthorized");
          }
          return;
        }

        if (msg.type === "send" && typeof msg.text === "string" && msg.text.trim()) {
          // Accusés d'envoi : le front joint un clientMessageId, renvoyé dans
          // send-ok/send-error pour réconcilier son message optimiste. Un
          // vieux front sans clientMessageId reçoit, comme avant, la frame
          // error générique en cas d'échec (et rien en cas de succès).
          const clientMessageId =
            typeof msg.clientMessageId === "string" && msg.clientMessageId ? msg.clientMessageId : null;
          const fail = (message: string) =>
            reply(clientMessageId ? { type: "send-error", clientMessageId, message } : { type: "error", message });
          const text = msg.text.trim();
          if (text.length > MAX_CHAT_TEXT_LENGTH) {
            // Borne d'entrée (revue, constat 8) : rien ne part vers la gateway.
            fail(`message trop long (max ${MAX_CHAT_TEXT_LENGTH} caractères)`);
            return;
          }
          gateway.sendChatMessage(text).then(
            (result) => {
              // L'envoi n'est accusé réussi qu'ici, quand chat.send a résolu
              // côté gateway ; le runId permet au front de lier la réponse.
              if (!clientMessageId) return;
              reply({
                type: "send-ok",
                clientMessageId,
                ...(typeof result?.runId === "string" ? { runId: result.runId } : {}),
              });
            },
            (err: Error) => fail(err.message),
          );
          return;
        }

        // Interruption best-effort du run en cours (RPC chat.abort).
        if (msg.type === "abort") {
          const runId = typeof msg.runId === "string" && msg.runId ? msg.runId : undefined;
          gateway.abortRun(runId).then(
            () => reply({ type: "abort-ok" }),
            (err: Error) => reply({ type: "abort-error", message: err.message }),
          );
          return;
        }
      },
      onClose(_evt, ws) {
        if (authTimer) clearTimeout(authTimer);
        chatClients.delete(registered ?? ws);
        registered = null;
      },
    };
  }),
);

// --- Fichiers : workspace de l'agent OpenClaw ---
// Lecture via la gateway (agents.workspace.*, operator.read, confinement et
// redaction côté serveur) ; écriture directe confinée sur le disque (voir
// src/workspace.ts — agents.files.set exigerait operator.admin).

app.get("/api/workspace", async (c) => {
  if (!gateway.isConnected) {
    return c.json({ error: "gateway déconnectée" }, 503);
  }
  const path = c.req.query("path") || undefined;
  try {
    const listing = (await gateway.getWorkspaceListing(path)) as {
      path?: unknown;
      entries?: unknown[];
      totalEntries?: unknown;
    } | null;
    const entries = Array.isArray(listing?.entries)
      ? listing.entries.filter((e) => (e as { name?: unknown } | null)?.name !== ".git")
      : [];
    return c.json({
      path: typeof listing?.path === "string" ? listing.path : (path ?? ""),
      entries,
      totalEntries: typeof listing?.totalEntries === "number" ? listing.totalEntries : entries.length,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

app.get("/api/workspace/file", async (c) => {
  if (!gateway.isConnected) {
    return c.json({ error: "gateway déconnectée" }, 503);
  }
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path requis" }, 400);
  try {
    const got = (await gateway.getWorkspaceFile(path)) as { file?: unknown } | null;
    if (!got?.file) return c.json({ error: "fichier introuvable" }, 404);
    return c.json({ file: got.file });
  } catch (err) {
    const message = (err as Error).message;
    const status = /not found|introuvable|no such/i.test(message) ? 404 : 502;
    return c.json({ error: message }, status);
  }
});

// Borne brute du body : 10 Mo utiles ≈ 13,4 Mo en base64 + enveloppe JSON.
const MAX_UPLOAD_BODY_BYTES = 15 * 1024 * 1024;

app.post("/api/workspace/files", async (c) => {
  const rawLength = Number(c.req.header("content-length") ?? 0);
  if (rawLength > MAX_UPLOAD_BODY_BYTES) {
    return c.json({ error: "corps de requête trop volumineux" }, 413);
  }
  let body: { path?: unknown; contentBase64?: unknown; contentText?: unknown; overwrite?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON invalide" }, 400);
  }
  const relPath = typeof body.path === "string" ? body.path : "";
  const hasBase64 = typeof body.contentBase64 === "string";
  const hasText = typeof body.contentText === "string";
  if (!relPath || hasBase64 === hasText) {
    return c.json({ error: "path et UN contenu (contentBase64 OU contentText) requis" }, 400);
  }

  let data: Uint8Array;
  if (hasBase64) {
    try {
      data = Uint8Array.from(Buffer.from(body.contentBase64 as string, "base64"));
    } catch {
      return c.json({ error: "base64 invalide" }, 400);
    }
  } else {
    data = new TextEncoder().encode(body.contentText as string);
  }

  if (!gateway.isConnected) {
    return c.json({ error: "gateway déconnectée — racine du workspace inconnue" }, 503);
  }
  const agent = await gateway.getDefaultAgent().catch(() => null);
  if (!agent?.workspace) {
    return c.json({ error: "workspace de l'agent introuvable" }, 503);
  }

  try {
    const saved = await saveWorkspaceFile(agent.workspace, relPath, data, body.overwrite === true);
    return c.json({ created: true, ...saved });
  } catch (err) {
    if (err instanceof WorkspaceWriteError) {
      const status =
        err.code === "invalid-path" ? 400
        : err.code === "too-large" ? 413
        : err.code === "exists" ? 409
        : 503;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "écriture impossible" }, 500);
  }
});

// Sert le front buildé (`bun run build`). En dev, Vite tourne à part (voir dev.ts)
// et proxy /api vers ce backend.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

const server = Bun.serve({
  port: env.port,
  hostname: env.bindHost,
  fetch: app.fetch,
  websocket,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received`);
  clearInterval(pruneTimer);
  for (const ws of chatClients) {
    try {
      ws.close(1001, "server shutting down");
    } catch {
      // La fermeture continue pour les autres ressources.
    }
  }
  chatClients.clear();
  try {
    gateway.stop();
  } catch (error) {
    console.error(`[shutdown] gateway: ${(error as Error).message}`);
  }
  try {
    await logTailer.stop();
  } catch (error) {
    console.error(`[shutdown] logs: ${(error as Error).message}`);
  }
  try {
    await statusCollector.stop();
  } catch (error) {
    console.error(`[shutdown] collector: ${(error as Error).message}`);
  }
  try {
    await openclawCollector.stop();
  } catch (error) {
    console.error(`[shutdown] OpenClaw collector: ${(error as Error).message}`);
  }
  try {
    await server.stop(true);
  } catch (error) {
    console.error(`[shutdown] server: ${(error as Error).message}`);
  }
  try {
    closeDatabase();
  } catch (error) {
    console.error(`[shutdown] database: ${(error as Error).message}`);
  }
  console.log("[shutdown] complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`clawdeck backend → http://${env.bindHost}:${env.port}`);
