// src/index.ts — backend Hono : health panel SSE + historique des pings.
// Sert aussi le front buildé (web/dist) en production (voir CLAUDE.md).

import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { WSContext } from "hono/ws";
import { getEnv } from "./env";
import { safeTokenEqual, parseHours, isValidBase64, MAX_CHAT_TEXT_LENGTH } from "./validate";
import {
  apiBearerAuth,
  healthz,
  HEALTHZ_PATH,
  securityHeaders,
} from "./security";
import { createStateLogger, logError, logInfo } from "./log";
import { closeDatabase, pruneOldPings, getPingHistoryBucketed } from "./db";
import { GatewayClient } from "./gateway/client";
import { collectStatus, type StatusPayload } from "./status";
import { StatusCollector } from "./status-collector";
import { LogTailer } from "./log-tailer";
import { normalizeLogTail, type DashboardLogEntry } from "./logs";
import { saveWorkspaceFile, WorkspaceWriteError } from "./workspace";
import { MediaReadError, resolveMediaPath, safeMediaType } from "./media";
import {
  NotificationHub,
  NotifyService,
  MAX_NOTIFY_BODY_BYTES,
  NOTIFY_KEEPALIVE_MS,
  NOTIFY_PAYLOAD_VERSION,
  NOTIFY_STREAM_QUEUE_MAX,
  type NotificationEvent,
} from "./notify";
import {
  readOpenClawRuntime,
  unavailableOpenClawRuntime,
} from "./openclaw-status";

const POLL_INTERVAL_MS = 5000;
// Délai laissé à la première connexion gateway avant de la déclarer
// indisponible dans le journal : plus long que le watchdog de handshake du
// client (10 s), donc au moins une tentative complète a eu lieu.
const GATEWAY_STARTUP_GRACE_MS = 15_000;

// `app` et `gateway` sont exportés pour les tests d'intégration des routes
// (index.test.ts), qui exercent l'app via app.request() en substituant les
// accès gateway — le démarrage réel reste réservé à `import.meta.main` (bas
// de fichier), donc importer ce module n'ouvre ni socket, ni port, ni base.
export const app = new Hono();
export const gateway = new GatewayClient(getEnv().gatewayWsUrl, getEnv().gatewayAuthToken, getEnv().gatewayDeviceIdentityPath);
const logTailer = new LogTailer(gateway);

// Journaux d'état : seules les bascules sont écrites, pas chaque cycle
// (voir createStateLogger). Les sondes partent de l'état nominal — leur
// succès au démarrage n'est pas un événement, leur premier échec si.
const gatewayLog = createStateLogger({
  scope: "gateway",
  ok: "connexion établie",
  failed: "connexion indisponible",
});
const openclawProbeLog = createStateLogger({
  scope: "openclaw",
  ok: "sonde rétablie",
  failed: "sonde en échec",
  initialOk: true,
});
const statusProbeLog = createStateLogger({
  scope: "status",
  ok: "sonde rétablie",
  failed: "sonde en échec",
  initialOk: true,
});

const openclawCollector = new StatusCollector(async () => {
  const runtime = await readOpenClawRuntime(gateway);
  openclawProbeLog.ok();
  return runtime;
}, {
  intervalMs: 15_000,
  onError: (error) => openclawProbeLog.failed(error.message),
});
const statusCollector = new StatusCollector(async () => {
  const payload = await collectStatus(
    gateway.isConnected
      ? openclawCollector.current ?? unavailableOpenClawRuntime(gateway, "OpenClaw status pending")
      : unavailableOpenClawRuntime(gateway),
  );
  statusProbeLog.ok();
  return payload;
}, {
  intervalMs: POLL_INTERVAL_MS,
  onError: (error) => statusProbeLog.failed(error.message),
});

// En-têtes de sécurité sur TOUTES les réponses — front buildé, API, 401
// compris : ils sont posés avant l'auth pour qu'une réponse d'erreur reste
// elle aussi protégée (voir security.ts).
app.use("*", securityHeaders());

// Auth bearer sur toute l'API (token depuis .env, jamais commité).
// Les exceptions (handshake WS, sonde de vie) sont listées et justifiées
// dans security.ts — un seul endroit à relire pour savoir ce qui est public.
app.use("/api/*", apiBearerAuth(getEnv().authToken));

app.get(HEALTHZ_PATH, healthz);

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

// Rétention 7 jours (voir RETENTION_MS dans db.ts) ; armée au démarrage.
let pruneTimer: ReturnType<typeof setInterval> | null = null;

// --- Notifications (phase 3) : POST /api/notify → navigateurs + ntfy ---
// La garde bearer de /api/* couvre déjà ces deux routes (voir security.ts).
// Rien n'est persisté : une notification vit le temps de sa diffusion.

const notifications = new NotificationHub();
const notifyService = new NotifyService({ hub: notifications, ntfy: getEnv().ntfy });

app.post("/api/notify", async (c) => {
  // Deux bornes successives : l'annonce content-length évite d'avaler un corps
  // manifestement trop gros, la taille réelle rattrape un en-tête absent ou
  // menteur — c'est la seconde qui protège vraiment.
  const announced = Number(c.req.header("content-length") ?? 0);
  const tooLarge = () =>
    c.json(
      {
        v: NOTIFY_PAYLOAD_VERSION,
        code: "body-too-large" as const,
        error: `corps de requête trop volumineux (max ${MAX_NOTIFY_BODY_BYTES} octets)`,
      },
      413,
    );
  if (announced > MAX_NOTIFY_BODY_BYTES) return tooLarge();

  const raw = await c.req.text();
  if (raw.length > MAX_NOTIFY_BODY_BYTES) return tooLarge();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json(
      { v: NOTIFY_PAYLOAD_VERSION, code: "invalid-json" as const, error: "JSON invalide" },
      400,
    );
  }

  const result = await notifyService.submit(body, c.req.header("Idempotency-Key") ?? null);
  if (result.retryAfterSeconds !== undefined) {
    c.header("Retry-After", String(result.retryAfterSeconds));
  }
  return c.json(result.body, result.status);
});

// Flux des notifications, sur le même motif que /api/status et /api/logs :
// un abonnement, une file par client, une boucle qui écrit ce qui attend.
// La différence tient à ce qui est diffusé — des ÉVÉNEMENTS distincts, pas un
// état. Un client lent ne peut donc pas se contenter du dernier reçu comme le
// fait /api/status : la file les conserve tous, jusqu'à sa borne.
app.get("/api/notifications", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let pending: NotificationEvent[] = [];
    let dropped = 0;
    let keepAlive = false;
    let wake: (() => void) | null = null;

    const notify = () => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    const unsubscribe = notifications.subscribe((event) => {
      pending.push(event);
      if (pending.length > NOTIFY_STREAM_QUEUE_MAX) {
        dropped += pending.length - NOTIFY_STREAM_QUEUE_MAX;
        pending = pending.slice(-NOTIFY_STREAM_QUEUE_MAX);
      }
      notify();
    });
    const keepAliveTimer = setInterval(() => {
      keepAlive = true;
      notify();
    }, NOTIFY_KEEPALIVE_MS);

    stream.onAbort(() => {
      closed = true;
      notify();
    });

    try {
      // Commentaire SSE d'ouverture : il ne porte aucune donnée (les parseurs
      // du front n'y voient aucune ligne `data:`) mais prouve tout de suite que
      // le flux est vivant, ce qu'aucune notification ne fera peut-être avant
      // des heures.
      await stream.write(": ouverture\n\n");
      while (!closed) {
        if (pending.length === 0 && dropped === 0 && !keepAlive) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (closed) break;
        if (keepAlive) {
          keepAlive = false;
          await stream.write(": keep-alive\n\n");
        }
        if (dropped > 0) {
          // Une perte se dit : un client qui a décroché doit pouvoir afficher
          // « n notifications manquées » plutôt que d'ignorer le trou.
          const count = dropped;
          dropped = 0;
          await stream.writeSSE({
            event: "notifications-dropped",
            data: JSON.stringify({ type: "notifications-dropped", count }),
          });
        }
        while (pending.length > 0) {
          const event = pending.shift() as NotificationEvent;
          await stream.writeSSE({ event: "notification", data: JSON.stringify(event) });
        }
      }
    } finally {
      clearInterval(keepAliveTimer);
      unsubscribe();
    }
  });
});

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
  // La déconnexion provoquée par notre propre arrêt n'est pas une panne : la
  // journaliser en warn ferait sonner une alerte à chaque redémarrage.
  if (status.connected) gatewayLog.ok();
  else if (!shuttingDown) gatewayLog.failed(status.error);
  broadcast({ type: "gateway-status", ...status });
  openclawCollector.refresh();
});
gateway.on("chat", (payload: unknown) => broadcast({ type: "chat", payload }));
gateway.on("agent", (payload: unknown) => broadcast({ type: "agent", payload }));
gateway.on("session-message", (payload: unknown) => broadcast({ type: "session-message", payload }));
// Route de livraison de la session : le composeur du front affiche où part un
// message (WhatsApp ou session interne seule).
gateway.on("delivery-route", (route: unknown) => broadcast({ type: "delivery-route", route }));
// Trou de seq sur la connexion gateway : des événements ont pu être manqués,
// on resonde immédiatement l'état OpenClaw.
gateway.on("resync", () => openclawCollector.refresh());

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
          if (msg.type === "auth" && safeTokenEqual(msg.token, getEnv().authToken)) {
            authed = true;
            if (authTimer) clearTimeout(authTimer);
            registered = ws;
            chatClients.add(ws);
            ws.send(JSON.stringify({ type: "auth-ok" }));
            ws.send(JSON.stringify({ type: "gateway-status", connected: gateway.isConnected }));
            ws.send(JSON.stringify({ type: "delivery-route", route: gateway.deliveryRouteInfo }));
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
                logError("chat", "historique gateway indisponible", {
                  raison: err instanceof Error ? err.message : String(err),
                });
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

// Média reçu par l'agent (photo, vocal WhatsApp). Le chemin ABSOLU vient du
// transcript et transite par le navigateur : il n'est jamais digne de
// confiance, d'où la résolution confinée de src/media.ts. Sans cette route,
// une photo envoyée depuis le téléphone n'apparaît que comme « média envoyé ».
app.get("/api/media", async (c) => {
  const requested = c.req.query("path");
  if (!requested) return c.json({ error: "paramètre path requis" }, 400);
  if (!gateway.isConnected) {
    return c.json({ error: "gateway déconnectée — racine du workspace inconnue" }, 503);
  }
  const agent = await gateway.getDefaultAgent().catch(() => null);
  if (!agent?.workspace) {
    return c.json({ error: "racine du workspace inconnue" }, 503);
  }

  try {
    const resolved = resolveMediaPath(agent.workspace, requested);
    const file = Bun.file(resolved);
    return new Response(file, {
      headers: {
        "content-type": safeMediaType(c.req.query("type")),
        // Contenu immuable (un média reçu ne change plus) mais privé : il ne
        // doit pas être mis en cache par un intermédiaire partagé.
        "cache-control": "private, max-age=3600",
        // Défense en profondeur : même avec un type neutralisé, on refuse
        // explicitement que le navigateur devine autre chose.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MediaReadError) {
      const status = error.code === "too-large" ? 413 : error.code === "not-found" ? 404 : 400;
      return c.json({ error: error.message, code: error.code }, status);
    }
    logError("media", "lecture de média impossible", {
      raison: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "lecture du média impossible" }, 500);
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
    // `Buffer.from(x, "base64")` ne lève JAMAIS : il ignore silencieusement
    // tout caractère hors alphabet. Le try/catch d'origine était donc une
    // branche morte, et un base64 malformé écrivait un fichier corrompu en
    // répondant 200. On valide la forme AVANT de décoder.
    const encoded = (body.contentBase64 as string).trim();
    if (!isValidBase64(encoded)) {
      return c.json({ error: "base64 invalide" }, 400);
    }
    data = Uint8Array.from(Buffer.from(encoded, "base64"));
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

let server: ReturnType<typeof Bun.serve> | null = null;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("arret", "signal reçu", { signal });
  if (pruneTimer) clearInterval(pruneTimer);
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
    logError("arret", "fermeture de la gateway", { raison: (error as Error).message });
  }
  try {
    await logTailer.stop();
  } catch (error) {
    logError("arret", "fermeture du tail de logs", { raison: (error as Error).message });
  }
  try {
    await statusCollector.stop();
  } catch (error) {
    logError("arret", "arrêt du collecteur de statuts", { raison: (error as Error).message });
  }
  try {
    await openclawCollector.stop();
  } catch (error) {
    logError("arret", "arrêt du collecteur OpenClaw", { raison: (error as Error).message });
  }
  try {
    await server?.stop(true);
  } catch (error) {
    logError("arret", "fermeture du serveur HTTP", { raison: (error as Error).message });
  }
  try {
    closeDatabase();
  } catch (error) {
    logError("arret", "fermeture de la base", { raison: (error as Error).message });
  }
  logInfo("arret", "arrêt terminé");
  process.exit(0);
}

// --- Démarrage ---
// Tout ce qui a un effet de bord observable — purge SQLite, connexion gateway,
// sondes, écoute HTTP, signaux — n'a lieu que si ce fichier est le point
// d'entrée (`bun src/index.ts`, cf. package.json et launchd). Sous `bun test`,
// index.ts n'est qu'importé : les routes sont exerçables sans qu'un serveur
// s'ouvre sur le port de production ni que la vraie base soit touchée.
if (import.meta.main) {
  pruneOldPings();
  pruneTimer = setInterval(pruneOldPings, 60 * 60 * 1000);

  openclawCollector.subscribe(() => statusCollector.refresh());
  gateway.start();
  openclawCollector.start();
  statusCollector.start();

  // Le client gateway n'émet un statut « déconnecté » que s'il a d'abord été
  // connecté : une gateway éteinte au démarrage (cas courant, launchd lance
  // clawdeck sans attendre OpenClaw) laisserait le journal muet sur ce qui
  // explique un dashboard vide. Un seul contrôle différé écrit la ligne
  // manquante ; les bascules suivantes viennent des événements.
  setTimeout(() => {
    if (!gateway.isConnected) gatewayLog.failed("aucune connexion depuis le démarrage");
  }, GATEWAY_STARTUP_GRACE_MS);

  server = Bun.serve({
    port: getEnv().port,
    hostname: getEnv().bindHost,
    fetch: app.fetch,
    websocket,
  });

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Seule ligne de démarrage : l'adresse d'écoute est ce que l'exploitant vient
  // chercher dans stdout.log (le bind est restreint au loopback ou à Tailscale,
  // voir getEnv().ts). Aucun token, aucun chemin de configuration.
  logInfo("http", "backend démarré", { adresse: `http://${getEnv().bindHost}:${getEnv().port}` });
}
