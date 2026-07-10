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

const PROTOCOL_VERSION = 4;
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

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
}

// Route de livraison d'une session vers son canal d'origine (ex. WhatsApp),
// extraite de sessions.list — permet de renvoyer la réponse de l'agent là où
// la conversation a lieu réellement.
interface DeliveryRoute {
  channel: string;
  to: string;
  accountId?: string;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private identity: DeviceIdentity;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private deliveryRoute: DeliveryRoute | null = null;
  mainSessionKey: string | null = null;

  constructor(
    private wsUrl: string,
    private authToken: string,
    identityPath: string,
  ) {
    super();
    this.identity = loadOrCreateDeviceIdentity(identityPath);
  }

  start() {
    this.closedByUs = false;
    this.openSocket();
  }

  stop() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  get isConnected() {
    return this.connected;
  }

  private openSocket() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

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
      const wasConnected = this.connected;
      this.connected = false;
      this.mainSessionKey = null;
      this.rejectAllPending(new Error("gateway connection closed"));
      if (wasConnected) this.emit("status", { connected: false });
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
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
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
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
      return;
    }
    this.connected = true;
    this.reconnectAttempt = 0;
    this.mainSessionKey = msg.payload?.snapshot?.sessionDefaults?.mainSessionKey ?? null;
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
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.connected) return Promise.reject(new Error("gateway not connected"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ type: "req", id, method, params });
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
