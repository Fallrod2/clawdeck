// src/gateway/client.ts — client WebSocket vers la gateway OpenClaw.
// Auth par identité d'appareil (Ed25519) avec le bypass de self-pairing
// réservé aux clients locaux { id: "gateway-client", mode: "backend" } —
// validé empiriquement contre une gateway réelle (voir protocol.ts).
//
// IMPORTANT : ne jamais envoyer de header Origin sur cette connexion. Le
// bypass de self-pairing l'exige explicitement (sinon la gateway traite la
// connexion comme un client navigateur et exige un pairing manuel).

import { EventEmitter } from "node:events";
import { loadOrCreateDeviceIdentity, publicKeyWireFormat, signPayload, type DeviceIdentity } from "./device-identity";
import { buildDeviceAuthPayloadV3 } from "./protocol";

const MIN_PROTOCOL_VERSION = 3;
const MAX_PROTOCOL_VERSION = 4;
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const CLIENT_PLATFORM = "web";
const DEVICE_FAMILY = "clawdeck";
const ROLE = "operator";
// operator.admin est requis pour forcer la route d'origine explicite d'un
// chat.send (livraison de la réponse vers WhatsApp) ; accordé automatiquement
// par le self-pairing loopback (voir device-identity/protocol).
const SCOPES = ["operator.read", "operator.write", "operator.admin"];
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// Délai maximal entre l'ouverture du socket et un connect-ok abouti. Sans ce
// watchdog, une gateway qui n'envoie jamais connect.challenge (gelée, proxy
// muet) laisserait le client ni connecté ni en reconnexion, sans récupération
// possible (voir docs/REVUE-2026-07-17.md, constat backend 2).
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GatewayLogTailResult {
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
}

// Route de livraison d'une session vers son canal d'origine (ex. WhatsApp),
// extraite de sessions.list — permet de renvoyer la réponse de l'agent là où
// la conversation a lieu réellement.
interface DeliveryRoute {
  channel: string;
  to: string;
  accountId?: string;
}

// Points d'injection réservés aux tests (socket factice, watchdog court) ;
// en production les valeurs par défaut s'appliquent.
export interface GatewayClientOptions {
  socketFactory?: (url: string) => WebSocket;
  handshakeTimeoutMs?: number;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private identity: DeviceIdentity;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private deliveryRoute: DeliveryRoute | null = null;
  private serverVersion: string | null = null;
  private serverUptimeMs: number | null = null;
  mainSessionKey: string | null = null;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly handshakeTimeoutMs: number;

  constructor(
    private wsUrl: string,
    private authToken: string,
    identityPath: string,
    options: GatewayClientOptions = {},
  ) {
    super();
    this.identity = loadOrCreateDeviceIdentity(identityPath);
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  start() {
    this.closedByUs = false;
    this.openSocket();
  }

  stop() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHandshakeTimer();
    this.ws?.close();
  }

  get isConnected() {
    return this.connected;
  }

  private openSocket() {
    const ws = this.socketFactory(this.wsUrl);
    this.ws = ws;

    // Watchdog de handshake : si connect-ok n'aboutit pas à temps (challenge
    // jamais reçu, réponse perdue), on ferme le socket pour retomber sur le
    // chemin normal onclose → reconnexion. Le timer appartient à CE socket :
    // devenu obsolète, il ne doit jamais toucher un socket plus récent.
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws === ws && !this.connected) ws.close();
    }, this.handshakeTimeoutMs);

    ws.onmessage = (ev) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      // Ne désarme le watchdog que s'il s'agit bien du socket courant.
      if (this.ws === ws) this.clearHandshakeTimer();
      const wasConnected = this.connected;
      this.connected = false;
      this.mainSessionKey = null;
      this.deliveryRoute = null;
      this.serverVersion = null;
      this.serverUptimeMs = null;
      this.rejectAllPending(new Error("gateway connection closed"));
      if (wasConnected) this.emit("status", { connected: false });
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private scheduleReconnect() {
    const capped = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    // Jitter (facteur aléatoire 0,5-1,0) : désynchronise les retentatives
    // pour ne pas marteler la gateway à cadence fixe à son redémarrage.
    const delay = capped * (0.5 + Math.random() * 0.5);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private handleMessage(msg: Record<string, any>) {
    if (msg.type === "event" && msg.event === "connect.challenge") {
      this.sendConnect(msg.payload.nonce);
      return;
    }

    if (msg.type === "res" && msg.id === "connect") {
      this.handleConnectResult(msg);
      return;
    }

    if (msg.type === "res") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new Error(msg.error?.message ?? "gateway request failed"));
      return;
    }

    if (msg.type === "event" && msg.event === "chat") {
      this.emit("chat", msg.payload);
      return;
    }
    if (msg.type === "event" && msg.event === "agent") {
      this.emit("agent", msg.payload);
      return;
    }
    // Miroir live : tout message ajouté à la transcription de la session
    // (WhatsApp entrant depuis le téléphone, réponses…). Voir setupSession().
    if (msg.type === "event" && msg.event === "session.message") {
      this.emit("session-message", msg.payload);
      return;
    }
  }

  private sendConnect(nonce: string) {
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: this.identity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: SCOPES,
      signedAtMs,
      token: this.authToken,
      nonce,
      platform: CLIENT_PLATFORM,
      deviceFamily: DEVICE_FAMILY,
    });
    const signature = signPayload(this.identity.privateKeyPem, payload);

    this.send({
      type: "req",
      id: "connect",
      method: "connect",
      params: {
        minProtocol: MIN_PROTOCOL_VERSION,
        maxProtocol: MAX_PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          version: "0.1.0",
          platform: CLIENT_PLATFORM,
          mode: CLIENT_MODE,
          deviceFamily: DEVICE_FAMILY,
        },
        role: ROLE,
        scopes: SCOPES,
        auth: { token: this.authToken },
        device: {
          id: this.identity.deviceId,
          publicKey: publicKeyWireFormat(this.identity.publicKeyPem),
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      },
    });
  }

  private handleConnectResult(msg: Record<string, any>) {
    if (!msg.ok) {
      this.emit("status", { connected: false, error: msg.error?.message });
      this.ws?.close(1008, "connect failed");
      return;
    }
    this.connected = true;
    this.clearHandshakeTimer();
    this.reconnectAttempt = 0;
    this.mainSessionKey = msg.payload?.snapshot?.sessionDefaults?.mainSessionKey ?? null;
    this.serverVersion = msg.payload?.server?.version ?? null;
    this.serverUptimeMs = msg.payload?.snapshot?.uptimeMs ?? null;
    this.emit("status", { connected: true });
    this.setupSession().catch(() => {
      // best-effort : sans route de livraison on retombe sur un envoi "interne"
    });
  }

  // Après connexion : récupère la route de livraison de la session principale
  // (canal d'origine, ex. WhatsApp) et s'abonne au flux de ses messages pour
  // le miroir live.
  private async setupSession() {
    if (!this.mainSessionKey) return;
    const key = this.mainSessionKey;

    try {
      const list = (await this.request("sessions.list", {})) as { sessions?: any[] };
      const entry = list.sessions?.find((s) => s.key === key);
      const ctx = entry?.deliveryContext;
      const channel = ctx?.channel ?? entry?.lastChannel ?? entry?.origin?.provider;
      const to = ctx?.to ?? entry?.lastTo ?? entry?.origin?.to;
      const accountId = ctx?.accountId ?? entry?.lastAccountId ?? entry?.origin?.accountId;
      if (channel && channel !== "webchat" && to) {
        this.deliveryRoute = { channel, to, accountId };
      }
    } catch {
      // pas de route : envoi interne seulement
    }

    try {
      await this.request("sessions.messages.subscribe", { key });
    } catch {
      // le miroir live sera indisponible mais le chat direct fonctionne
    }
  }

  private send(frame: unknown) {
    this.ws?.send(JSON.stringify(frame));
  }

  private rejectAllPending(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.connected) return Promise.reject(new Error("gateway not connected"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({ type: "req", id, method, params });
    });
  }

  get version(): string | null {
    return this.serverVersion;
  }

  get uptimeMs(): number | null {
    return this.serverUptimeMs;
  }

  getHealthSnapshot(): Promise<unknown> {
    return this.request("health", { probe: false }, 8_000);
  }

  getStatusSummary(): Promise<unknown> {
    return this.request("status", { includeChannelSummary: true }, 8_000);
  }

  getWhatsAppStatus(): Promise<unknown> {
    return this.request(
      "channels.status",
      { channel: "whatsapp", probe: false, timeoutMs: 3_000 },
      8_000,
    );
  }

  getConfiguredModels(): Promise<unknown> {
    return this.request("models.list", { view: "configured" }, 8_000);
  }

  getLogs(cursor?: number): Promise<GatewayLogTailResult> {
    return this.request("logs.tail", {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 200,
      maxBytes: 100_000,
    });
  }

  async sendChatMessage(text: string): Promise<{ runId: string; status: string }> {
    if (!this.mainSessionKey) throw new Error("no active session");
    // deliver + route d'origine explicite : la réponse de l'agent repart sur
    // le canal réel de la session (ex. WhatsApp), pas seulement en RPC. Sans
    // route connue, envoi interne classique.
    const route = this.deliveryRoute;
    return this.request("chat.send", {
      sessionKey: this.mainSessionKey,
      message: text,
      idempotencyKey: crypto.randomUUID(),
      ...(route
        ? {
            deliver: true,
            originatingChannel: route.channel,
            originatingTo: route.to,
            ...(route.accountId ? { originatingAccountId: route.accountId } : {}),
          }
        : {}),
    });
  }

  async getHistory(limit = 50): Promise<unknown> {
    if (!this.mainSessionKey) return null;
    try {
      return await this.request("chat.history", { sessionKey: this.mainSessionKey, limit });
    } catch {
      return null;
    }
  }
}
