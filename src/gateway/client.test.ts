// src/gateway/client.test.ts — durcissement protocolaire du GatewayClient :
// watchdogs (handshake, tick), négociation de version, découverte des
// méthodes, retryAfterMs, arrêt sur échec d'auth, suivi de seq. Sockets
// factices via la factory injectable (aucun réseau réel, vrais timers courts).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "./client";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await Bun.sleep(5);
  }
}

// Socket factice minimal : muet par défaut (n'envoie jamais connect.challenge),
// piloté à la main par les tests via receive()/onclose.
class FakeSocket {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;
  lastCloseCode: number | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCalls += 1;
    if (code !== undefined) this.lastCloseCode = code;
    // Comme un vrai socket, la fermeture déclenche onclose de façon asynchrone.
    queueMicrotask(() => this.onclose?.(new CloseEvent("close")));
  }

  receive(frame: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  sentFrames(): Array<Record<string, any>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

const identityDir = mkdtempSync(join(tmpdir(), "clawdeck-test-identity-"));
afterAll(() => rmSync(identityDir, { recursive: true, force: true }));

function createClient(options: { handshakeTimeoutMs?: number; tickIntervalFallbackMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new GatewayClient(
    "ws://gateway.test",
    "token-test",
    join(identityDir, "identity.json"),
    {
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 25,
      tickIntervalFallbackMs: options.tickIntervalFallbackMs,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
  );
  return { client, sockets };
}

// Toutes les méthodes que le client consomme, telles qu'annoncées par la
// découverte d'une gateway complète.
const ALL_METHODS = [
  "health",
  "status",
  "channels.status",
  "models.list",
  "logs.tail",
  "sessions.list",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "chat.history",
  "chat.send",
  "chat.abort",
];

// hello-ok complet et réaliste : tous les champs requis par le schéma
// (protocol, server, features, snapshot, auth, policy). tickIntervalMs long
// par défaut — les tests de vivacité le raccourcissent explicitement, et
// `tickIntervalMs: null` omet le champ de policy (gateway sans annonce).
function helloOk(overrides: {
  protocol?: number;
  methods?: string[];
  tickIntervalMs?: number | null;
  scopes?: string[];
  mainSessionKey?: string;
} = {}) {
  const tickIntervalMs = overrides.tickIntervalMs === undefined ? 60_000 : overrides.tickIntervalMs;
  return {
    type: "hello-ok",
    protocol: overrides.protocol ?? 4,
    server: { version: "2026.7.1", connId: "conn-test" },
    features: {
      methods: overrides.methods ?? ALL_METHODS,
      events: ["tick", "chat", "agent", "session.message"],
    },
    snapshot: {
      uptimeMs: 12_345,
      sessionDefaults: { mainSessionKey: overrides.mainSessionKey ?? "main" },
    },
    auth: { role: "operator", scopes: overrides.scopes ?? ["operator.read", "operator.write"] },
    policy: {
      maxPayload: 1_000_000,
      maxBufferedBytes: 4_000_000,
      ...(tickIntervalMs !== null ? { tickIntervalMs } : {}),
    },
  };
}

function performHandshake(socket: FakeSocket, hello: Record<string, unknown> = helloOk()) {
  socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-test" } });
  socket.receive({ type: "res", id: "connect", ok: true, payload: hello });
}

describe("GatewayClient — watchdog de handshake", () => {
  test("ferme un socket resté muet puis relance une connexion", async () => {
    const { client, sockets } = createClient({ handshakeTimeoutMs: 25 });
    client.start();

    expect(sockets.length).toBe(1);
    const first = sockets[0]!;
    expect(first.closeCalls).toBe(0);

    // Aucun connect.challenge n'arrive : le watchdog ferme le socket…
    await waitFor(() => first.closeCalls >= 1);
    expect(client.isConnected).toBe(false);

    // …et le chemin normal onclose → reconnexion ouvre un nouveau socket.
    await waitFor(() => sockets.length >= 2, 2_000);

    client.stop();
  });

  test("ne ferme rien une fois la connexion aboutie", async () => {
    const { client, sockets } = createClient({ handshakeTimeoutMs: 25 });
    client.start();
    const socket = sockets[0]!;

    // Handshake complet : challenge de la gateway puis hello-ok intégral.
    socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-test" } });
    expect(socket.sent.length).toBe(1);
    socket.receive({ type: "res", id: "connect", ok: true, payload: helloOk() });
    expect(client.isConnected).toBe(true);

    // Bien après l'échéance du watchdog, le socket n'a jamais été fermé.
    await Bun.sleep(80);
    expect(socket.closeCalls).toBe(0);
    expect(client.isConnected).toBe(true);
    expect(sockets.length).toBe(1);

    client.stop();
  });
});

describe("GatewayClient — négociation hello-ok", () => {
  test("connexion nominale : protocole négocié, scopes accordés, découverte", () => {
    const { client, sockets } = createClient();
    client.start();
    performHandshake(sockets[0]!);

    expect(client.isConnected).toBe(true);
    expect(client.negotiatedProtocol).toBe(4);
    expect(client.grantedScopes).toEqual(["operator.read", "operator.write"]);
    expect(client.supportsMethod("chat.send")).toBe(true);
    expect(client.supportsLogs).toBe(true);

    client.stop();
  });

  test("protocole hors plage : jamais connecté, fermeture puis reconnexion", async () => {
    const { client, sockets } = createClient();
    client.start();
    const first = sockets[0]!;
    performHandshake(first, helloOk({ protocol: 99 }));

    expect(client.isConnected).toBe(false);
    expect(client.negotiatedProtocol).toBe(null);
    expect(first.closeCalls).toBe(1);

    // Chemin onclose → backoff normal → nouveau socket.
    await waitFor(() => sockets.length >= 2, 2_000);
    expect(client.isConnected).toBe(false);

    client.stop();
  });

  test("découverte sans sessions.messages.subscribe : aucun abonnement envoyé", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(
      socket,
      helloOk({ methods: ALL_METHODS.filter((m) => m !== "sessions.messages.subscribe") }),
    );
    expect(client.supportsMethod("sessions.messages.subscribe")).toBe(false);

    // setupSession résout la route (sessions.list) puis DOIT s'arrêter là :
    // aucun abonnement quand la méthode n'est pas annoncée.
    await waitFor(() => socket.sentFrames().some((f) => f.method === "sessions.list"));
    const listReq = socket.sentFrames().find((f) => f.method === "sessions.list")!;
    socket.receive({ type: "res", id: listReq.id, ok: true, payload: { sessions: [{ key: "main" }] } });
    await Bun.sleep(20);
    expect(socket.sentFrames().some((f) => f.method === "sessions.messages.subscribe")).toBe(false);
    client.stop();
  });
});

describe("GatewayClient — échecs de connect", () => {
  test("retryAfterMs : reconnexion à l'échéance imposée, backoff préservé", async () => {
    const { client, sockets } = createClient();
    client.start();

    const failWithRetry = (socket: FakeSocket) => {
      socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
      socket.receive({
        type: "res",
        id: "connect",
        ok: false,
        error: {
          message: "gateway starting",
          retryAfterMs: 40,
          details: { code: "UNAVAILABLE", reason: "startup-sidecars" },
        },
      });
    };

    failWithRetry(sockets[0]!);
    const t0 = Date.now();
    await waitFor(() => sockets.length >= 2, 1_000);
    const firstDelay = Date.now() - t0;
    expect(firstDelay).toBeGreaterThanOrEqual(30);
    expect(firstDelay).toBeLessThanOrEqual(200);

    // Deuxième échec identique : le délai imposé reste ~40 ms.
    failWithRetry(sockets[1]!);
    const t1 = Date.now();
    await waitFor(() => sockets.length >= 3, 1_000);
    expect(Date.now() - t1).toBeLessThanOrEqual(200);

    // Troisième échec SANS retryAfterMs : retour au backoff normal, resté à
    // sa base (les délais imposés n'ont pas incrémenté reconnectAttempt) —
    // premier délai de backoff entre 500 et 1 000 ms, jamais plusieurs
    // secondes comme après deux tentatives comptées.
    const third = sockets[2]!;
    third.receive({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
    third.receive({ type: "res", id: "connect", ok: false, error: { message: "still starting" } });
    const t2 = Date.now();
    await waitFor(() => sockets.length >= 4, 2_000);
    expect(Date.now() - t2).toBeLessThanOrEqual(1_500);

    client.stop();
  });

  test("AUTH_TOKEN_MISMATCH : erreur opérateur, plus aucune reconnexion, start() relance", async () => {
    const { client, sockets } = createClient();
    const statuses: Array<{ connected: boolean; error?: string }> = [];
    client.on("status", (s) => statuses.push(s));
    client.start();

    const socket = sockets[0]!;
    socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
    socket.receive({
      type: "res",
      id: "connect",
      ok: false,
      error: { message: "device token mismatch", details: { code: "AUTH_TOKEN_MISMATCH" } },
    });

    expect(socket.closeCalls).toBe(1);
    const authStatus = statuses.find((s) => s.error?.includes("GATEWAY_AUTH_TOKEN"));
    expect(authStatus).toBeDefined();
    expect(authStatus!.connected).toBe(false);

    // Bien au-delà du premier délai de backoff (≤ 1 000 ms) : aucun nouveau
    // socket, la reconnexion automatique est suspendue.
    await Bun.sleep(1_100);
    expect(sockets.length).toBe(1);

    // Une action opérateur (redémarrage → start()) réarme la connexion.
    client.start();
    expect(sockets.length).toBe(2);

    client.stop();
  });
});

describe("GatewayClient — vivacité (tick)", () => {
  test("silence entrant au-delà de 2 × tickIntervalMs : fermeture 4000 puis reconnexion", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket, helloOk({ tickIntervalMs: 15 }));
    expect(client.isConnected).toBe(true);

    // Plus aucune frame entrante : échéance à ~30 ms.
    await waitFor(() => socket.closeCalls >= 1);
    expect(socket.lastCloseCode).toBe(4000);
    await waitFor(() => sockets.length >= 2, 2_000);

    client.stop();
  });

  test("des frames régulières maintiennent la connexion au-delà de 2 × tickIntervalMs", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket, helloOk({ tickIntervalMs: 40 }));

    // 12 frames espacées de ~15 ms (échéance : 80 ms), soit ~180 ms au total :
    // le watchdog est réarmé à chaque frame, jamais déclenché.
    for (let seq = 1; seq <= 12; seq++) {
      socket.receive({ type: "event", event: "tick", payload: {}, seq });
      await Bun.sleep(15);
    }
    expect(socket.closeCalls).toBe(0);
    expect(client.isConnected).toBe(true);

    client.stop();
  });

  test("sans annonce de policy, le fallback injectable s'applique", async () => {
    const { client, sockets } = createClient({ tickIntervalFallbackMs: 15 });
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket, helloOk({ tickIntervalMs: null }));
    expect(client.isConnected).toBe(true);

    await waitFor(() => socket.closeCalls >= 1);
    expect(socket.lastCloseCode).toBe(4000);

    client.stop();
  });
});

describe("GatewayClient — suivi de seq", () => {
  test("un trou déclenche une seule resynchronisation, un retour en arrière aucune", () => {
    const { client, sockets } = createClient();
    const resyncs: unknown[] = [];
    client.on("resync", (info) => resyncs.push(info));
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);

    socket.receive({ type: "event", event: "agent", payload: {}, seq: 1 });
    socket.receive({ type: "event", event: "agent", payload: {}, seq: 2 });
    socket.receive({ type: "event", event: "agent", payload: {}, seq: 5 });
    expect(resyncs).toEqual([{ reason: "seq-gap" }]);

    // Après adoption du nouveau seq, la suite contiguë ne signale rien…
    socket.receive({ type: "event", event: "agent", payload: {}, seq: 6 });
    expect(resyncs.length).toBe(1);

    // …et un seq qui repart en arrière est un nouveau flux : pas de resync.
    socket.receive({ type: "event", event: "agent", payload: {}, seq: 1 });
    socket.receive({ type: "event", event: "agent", payload: {}, seq: 2 });
    expect(resyncs.length).toBe(1);

    client.stop();
  });
});

describe("GatewayClient — sendChatMessage", () => {
  // Répond au sessions.list de setupSession avec l'entrée fournie, puis
  // attend que la route soit digérée.
  async function answerSessionsList(socket: FakeSocket, entry: Record<string, unknown>) {
    await waitFor(() => socket.sentFrames().some((f) => f.method === "sessions.list"));
    const req = socket.sentFrames().find((f) => f.method === "sessions.list")!;
    socket.receive({ type: "res", id: req.id, ok: true, payload: { sessions: [entry] } });
    await Bun.sleep(10);
  }

  test("route WhatsApp connue : deliver + originating* épinglés (admin assumé)", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);
    await answerSessionsList(socket, {
      key: "main",
      deliveryContext: { channel: "whatsapp", to: "+33600000000", accountId: "default" },
    });

    const promise = client.sendChatMessage("bonjour");
    const frame = socket.sentFrames().find((f) => f.method === "chat.send");
    expect(frame).toBeDefined();
    const params = frame!.params as Record<string, unknown>;
    expect(params.deliver).toBe(true);
    expect(params.originatingChannel).toBe("whatsapp");
    expect(params.originatingTo).toBe("+33600000000");
    expect(params.originatingAccountId).toBe("default");

    socket.receive({ type: "res", id: frame!.id, ok: true, payload: { runId: "r1", status: "queued" } });
    await expect(promise).resolves.toEqual({ runId: "r1", status: "queued" });
    client.stop();
  });

  test("session basculée webchat : la route réelle est reprise du premier candidat non-webchat", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);
    // deliveryContext ET last* pollués par webchat ; origin porte encore la
    // vraie route — le scénario constaté en prod le 2026-07-18.
    await answerSessionsList(socket, {
      key: "main",
      deliveryContext: { channel: "webchat" },
      lastChannel: "webchat",
      origin: { provider: "whatsapp", to: "+33600000000" },
    });

    // stop() rejettera la requête en attente : rejet absorbé, seul le
    // contenu de la frame nous intéresse ici.
    client.sendChatMessage("bonjour").catch(() => {});
    const frame = socket.sentFrames().find((f) => f.method === "chat.send")!;
    const params = frame.params as Record<string, unknown>;
    expect(params.originatingChannel).toBe("whatsapp");
    expect(params.originatingTo).toBe("+33600000000");
    client.stop();
  });

  test("aucune route connue : deliver seul, aucun champ originating*", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);
    await answerSessionsList(socket, { key: "main", deliveryContext: { channel: "webchat" } });

    client.sendChatMessage("bonjour").catch(() => {});
    // Route nulle : l'envoi re-tente une résolution (2e sessions.list) —
    // toujours webchat, donc chat.send part avec deliver seul.
    await waitFor(() => socket.sentFrames().filter((f) => f.method === "sessions.list").length >= 2);
    const retryReq = socket.sentFrames().filter((f) => f.method === "sessions.list")[1]!;
    socket.receive({
      type: "res",
      id: retryReq.id,
      ok: true,
      payload: { sessions: [{ key: "main", deliveryContext: { channel: "webchat" } }] },
    });
    await waitFor(() => socket.sentFrames().some((f) => f.method === "chat.send"));
    const frame = socket.sentFrames().find((f) => f.method === "chat.send")!;
    const params = frame.params as Record<string, unknown>;
    expect(params.deliver).toBe(true);
    expect(params).not.toHaveProperty("originatingChannel");
    expect(params).not.toHaveProperty("originatingTo");
    client.stop();
  });
});

describe("GatewayClient — abortRun", () => {
  test("après handshake : frame chat.abort avec la clé de session et le runId", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);

    const promise = client.abortRun("run-42");
    const frame = socket.sentFrames().find((f) => f.method === "chat.abort");
    expect(frame).toBeDefined();
    expect(frame!.params).toEqual({ sessionKey: "main", runId: "run-42" });

    socket.receive({ type: "res", id: frame!.id, ok: true, payload: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });

    client.stop();
  });

  test("sans runId : params réduits à la session ; sans session : rejet immédiat", async () => {
    const { client, sockets } = createClient();
    // Avant toute connexion, pas de session principale connue.
    await expect(client.abortRun("run-1")).rejects.toThrow("no active session");

    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);

    const promise = client.abortRun();
    const frame = socket.sentFrames().find((f) => f.method === "chat.abort");
    expect(frame).toBeDefined();
    expect(frame!.params).toEqual({ sessionKey: "main" });

    socket.receive({ type: "res", id: frame!.id, ok: true, payload: {} });
    await promise;

    client.stop();
  });
});

describe("GatewayClient — stop()", () => {
  test("après abonnement réussi : frame unsubscribe best-effort avant fermeture", async () => {
    const { client, sockets } = createClient();
    client.start();
    const socket = sockets[0]!;
    performHandshake(socket);

    // setupSession : sessions.list (route) puis abonnement, tous deux acquittés.
    await waitFor(() => socket.sentFrames().some((f) => f.method === "sessions.list"));
    const listReq = socket.sentFrames().find((f) => f.method === "sessions.list")!;
    socket.receive({ type: "res", id: listReq.id, ok: true, payload: { sessions: [{ key: "main" }] } });
    await waitFor(() => socket.sentFrames().some((f) => f.method === "sessions.messages.subscribe"));
    const subReq = socket.sentFrames().find((f) => f.method === "sessions.messages.subscribe")!;
    socket.receive({ type: "res", id: subReq.id, ok: true, payload: {} });
    // Laisse la continuation de setupSession poser la trace d'abonnement.
    await Bun.sleep(10);

    client.stop();

    // La frame de désabonnement est la dernière envoyée, AVANT l'unique close.
    const frames = socket.sentFrames();
    const unsub = frames[frames.length - 1]!;
    expect(unsub.method).toBe("sessions.messages.unsubscribe");
    expect(unsub.params).toEqual({ key: "main" });
    expect(socket.closeCalls).toBe(1);
  });
});
