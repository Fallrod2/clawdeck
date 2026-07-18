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
// operator.admin est un choix DÉLIBÉRÉ, pas un défaut : la continuité
// WhatsApp exige la route d'origine explicite sur chat.send (champs
// originating*, réservés admin par le handler), sans quoi chaque message
// envoyé depuis le dashboard re-marque la session « webchat » et les
// réponses de l'agent cessent d'arriver sur le téléphone (constaté en prod
// le 2026-07-18 : session recréée côté webchat, route WhatsApp perdue).
// Coût accepté sur un tailnet privé mono-utilisateur : un slash-command
// d'administration tapé dans le chat (ex. /config set) sera exécutable.
const SCOPES = ["operator.read", "operator.write", "operator.admin"];
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// Délai maximal entre l'ouverture du socket et un connect-ok abouti. Sans ce
// watchdog, une gateway qui n'envoie jamais connect.challenge (gelée, proxy
// muet) laisserait le client ni connecté ni en reconnexion, sans récupération
// possible (voir docs/REVUE-2026-07-17.md, constat backend 2).
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Intervalle de tick retenu quand hello-ok n'annonce pas policy.tickIntervalMs
// (même défaut que le client de référence). Le watchdog de vivacité ferme la
// connexion avec le code 4000 après 2 × cet intervalle sans frame entrante.
const TICK_INTERVAL_FALLBACK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Route de livraison de la session principale vers son canal d'origine
// (ex. WhatsApp) : épinglée explicitement sur chaque chat.send pour que la
// réponse reparte sur le téléphone ET que la session ne bascule pas webchat.
interface DeliveryRoute {
  channel: string;
  to: string;
  accountId?: string;
}

export interface GatewayLogTailResult {
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
}

// Points d'injection réservés aux tests (socket factice, watchdog court) ;
// en production les valeurs par défaut s'appliquent.
export interface GatewayClientOptions {
  socketFactory?: (url: string) => WebSocket;
  handshakeTimeoutMs?: number;
  // Fallback du watchdog de vivacité quand la gateway n'annonce pas
  // policy.tickIntervalMs (les tests le raccourcissent).
  tickIntervalFallbackMs?: number;
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
  // Levé sur échec d'auth définitif (AUTH_*_MISMATCH) : plus aucune
  // reconnexion automatique tant que start() n'est pas rappelé.
  private reconnectSuspended = false;
  // Délai imposé par la gateway (retryAfterMs d'un échec de connect) pour la
  // prochaine tentative ; consommé par scheduleReconnect sans toucher au
  // backoff exponentiel.
  private nextReconnectDelayMs: number | null = null;
  private serverVersion: string | null = null;
  private serverUptimeMs: number | null = null;
  // État négocié dans hello-ok, valable pour la connexion courante seulement.
  private negotiatedProtocolVersion: number | null = null;
  private availableMethods: Set<string> | null = null;
  private policyTickIntervalMs: number | null = null;
  private authScopes: string[] | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  // Dernier seq d'événement vu sur la connexion courante (trou = resync).
  private lastEventSeq: number | null = null;
  // Clé de session dont l'abonnement aux messages a réussi (setupSession).
  private subscribedSessionKey: string | null = null;
  private deliveryRoute: DeliveryRoute | null = null;
  // Agent par défaut (id + racine workspace), mis en cache par connexion —
  // consommé par l'onglet Fichiers (navigation gateway + upload local).
  private defaultAgentCache: { id: string; workspace: string | null } | null = null;
  mainSessionKey: string | null = null;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly handshakeTimeoutMs: number;
  private readonly tickIntervalFallbackMs: number;

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
    this.tickIntervalFallbackMs = options.tickIntervalFallbackMs ?? TICK_INTERVAL_FALLBACK_MS;
  }

  start() {
    this.closedByUs = false;
    this.reconnectSuspended = false;
    this.nextReconnectDelayMs = null;
    this.openSocket();
  }

  stop() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHandshakeTimer();
    this.clearTickTimer();
    // Désabonnement best-effort du miroir de session : une frame sans réponse
    // attendue (ni timer ni pending) — la gateway nettoie de toute façon ses
    // abonnements à la déconnexion.
    if (this.connected && this.subscribedSessionKey) {
      try {
        this.send({
          type: "req",
          id: String(this.nextId++),
          method: "sessions.messages.unsubscribe",
          params: { key: this.subscribedSessionKey },
        });
      } catch {
        // socket déjà mort : la fermeture suffit
      }
    }
    this.ws?.close();
  }

  get isConnected() {
    return this.connected;
  }

  // Version de protocole négociée dans hello-ok (null hors connexion).
  get negotiatedProtocol(): number | null {
    return this.negotiatedProtocolVersion;
  }

  // Scopes réellement accordés par la gateway (payload.auth.scopes).
  get grantedScopes(): string[] | null {
    return this.authScopes ? [...this.authScopes] : null;
  }

  // Découverte conservatrice : liste absente ou vide → tout est réputé
  // supporté (fail-open, la gateway refusera elle-même une méthode inconnue).
  supportsMethod(name: string): boolean {
    return this.availableMethods === null || this.availableMethods.has(name);
  }

  // Consommé par LogTailer (compatibilité structurelle) pour sauter le poll
  // sans erreur répétée quand logs.tail n'est pas annoncé.
  get supportsLogs(): boolean {
    return this.supportsMethod("logs.tail");
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
      // Vivacité : toute frame entrante réarme le watchdog de tick, avant
      // même le parsing (un JSON invalide prouve aussi que la liaison vit).
      if (this.connected && this.ws === ws) this.armTickWatchdog();
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      // Ne désarme les watchdogs que s'il s'agit bien du socket courant.
      if (this.ws === ws) {
        this.clearHandshakeTimer();
        this.clearTickTimer();
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.mainSessionKey = null;
      this.serverVersion = null;
      this.serverUptimeMs = null;
      this.negotiatedProtocolVersion = null;
      this.availableMethods = null;
      this.policyTickIntervalMs = null;
      this.authScopes = null;
      this.lastEventSeq = null;
      this.subscribedSessionKey = null;
      this.deliveryRoute = null;
      this.defaultAgentCache = null;
      this.rejectAllPending(new Error("gateway connection closed"));
      if (wasConnected) this.emit("status", { connected: false });
      if (!this.closedByUs && !this.reconnectSuspended) this.scheduleReconnect();
    };
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearTickTimer() {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // Watchdog de vivacité post-connexion : la gateway émet des ticks
  // périodiques ; un silence entrant au-delà de 2 × tickIntervalMs signifie
  // une liaison morte, fermée avec le code 4000 comme le client de référence
  // (chemin onclose → reconnexion). Comme le watchdog de handshake, le timer
  // appartient à SON socket et ne touche jamais un socket plus récent.
  private armTickWatchdog() {
    this.clearTickTimer();
    const ws = this.ws;
    if (!ws || !this.connected) return;
    const idleLimitMs = 2 * (this.policyTickIntervalMs ?? this.tickIntervalFallbackMs);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      if (this.ws === ws && this.connected) ws.close(4000, "tick timeout");
    }, idleLimitMs);
  }

  private scheduleReconnect() {
    // Délai imposé par la gateway (retryAfterMs) : on l'honore tel quel,
    // sans compter la tentative dans le backoff exponentiel.
    const imposed = this.nextReconnectDelayMs;
    this.nextReconnectDelayMs = null;
    if (imposed !== null) {
      this.reconnectTimer = setTimeout(() => this.openSocket(), imposed);
      return;
    }
    const capped = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    // Jitter (facteur aléatoire 0,5-1,0) : désynchronise les retentatives
    // pour ne pas marteler la gateway à cadence fixe à son redémarrage.
    const delay = capped * (0.5 + Math.random() * 0.5);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  // seq par connexion, monotone sur les frames event : un trou signifie des
  // événements manqués → un seul "resync" par trou détecté, puis adoption du
  // nouveau seq. Un seq qui recule trahit un nouveau flux : adoption muette.
  private trackEventSeq(msg: Record<string, any>) {
    const seq = msg.seq;
    if (typeof seq !== "number" || !Number.isFinite(seq)) return;
    if (this.lastEventSeq !== null && seq > this.lastEventSeq + 1) {
      this.emit("resync", { reason: "seq-gap" });
    }
    this.lastEventSeq = seq;
  }

  private handleMessage(msg: Record<string, any>) {
    if (msg.type === "event") this.trackEventSeq(msg);

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
      const error = msg.error ?? {};
      const details = error.details ?? {};
      const code = details.code ?? error.code;

      // Échec d'auth définitif : la spec demande d'arrêter les boucles de
      // reconnexion et de guider l'opérateur. Seul start() réarme.
      if (code === "AUTH_TOKEN_MISMATCH" || code === "AUTH_SCOPE_MISMATCH") {
        this.reconnectSuspended = true;
        const guidance = code === "AUTH_TOKEN_MISMATCH"
          ? "corriger GATEWAY_AUTH_TOKEN dans .env"
          : "corriger les scopes demandés (SCOPES, gateway/client.ts)";
        const message =
          `authentification refusée par la gateway (${code}) : ${guidance} ` +
          "puis redémarrer clawdeck — reconnexion automatique suspendue";
        console.error(`[gateway] ${message}`);
        this.emit("status", { connected: false, error: message });
        this.ws?.close(1008, "connect failed");
        return;
      }

      // La gateway peut imposer le délai de la prochaine tentative (ex.
      // details.reason "startup-sidecars" pendant son démarrage).
      const retryAfterMs = error.retryAfterMs ?? details.retryAfterMs;
      if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        this.nextReconnectDelayMs = retryAfterMs;
      }
      this.emit("status", { connected: false, error: error.message });
      this.ws?.close(1008, "connect failed");
      return;
    }

    // hello-ok : le protocole négocié doit tomber dans notre plage, sinon on
    // refuse la session (fermeture → backoff normal) plutôt que de parler un
    // dialecte qu'on ne comprend pas.
    const protocol = msg.payload?.protocol;
    if (
      typeof protocol !== "number" ||
      protocol < MIN_PROTOCOL_VERSION ||
      protocol > MAX_PROTOCOL_VERSION
    ) {
      const label = typeof protocol === "number" ? `v${protocol}` : String(protocol);
      console.error(
        `[gateway] protocole négocié ${label} hors plage supportée ` +
          `[${MIN_PROTOCOL_VERSION}, ${MAX_PROTOCOL_VERSION}] — fermeture`,
      );
      this.emit("status", { connected: false, error: `protocole gateway ${label} non supporté` });
      this.ws?.close();
      return;
    }

    this.connected = true;
    this.clearHandshakeTimer();
    this.reconnectAttempt = 0;
    this.nextReconnectDelayMs = null;
    this.negotiatedProtocolVersion = protocol;
    this.lastEventSeq = null;

    // Découverte conservatrice des méthodes annoncées ; liste absente ou
    // vide → fail-open (supportsMethod répond vrai pour tout).
    const methods = msg.payload?.features?.methods;
    const methodNames: string[] = Array.isArray(methods)
      ? methods.filter((m: unknown): m is string => typeof m === "string")
      : [];
    this.availableMethods = methodNames.length > 0 ? new Set(methodNames) : null;

    const tickIntervalMs = msg.payload?.policy?.tickIntervalMs;
    this.policyTickIntervalMs =
      typeof tickIntervalMs === "number" && Number.isFinite(tickIntervalMs) && tickIntervalMs > 0
        ? tickIntervalMs
        : null;

    const scopes = msg.payload?.auth?.scopes;
    this.authScopes = Array.isArray(scopes)
      ? scopes.filter((s: unknown): s is string => typeof s === "string")
      : null;

    this.mainSessionKey = msg.payload?.snapshot?.sessionDefaults?.mainSessionKey ?? null;
    this.serverVersion = msg.payload?.server?.version ?? null;
    this.serverUptimeMs = msg.payload?.snapshot?.uptimeMs ?? null;
    this.armTickWatchdog();
    this.emit("status", { connected: true });
    this.setupSession().catch(() => {
      // best-effort : sans route de livraison on retombe sur un envoi "interne"
    });
  }

  // Après connexion : résout la route de livraison de la session principale
  // et s'abonne au flux de ses messages pour le miroir live.
  private async setupSession() {
    if (!this.mainSessionKey) return;
    const key = this.mainSessionKey;

    if (this.supportsMethod("sessions.list")) {
      try {
        const list = (await this.request("sessions.list", {})) as { sessions?: any[] };
        const entry = list.sessions?.find((s) => s.key === key);
        // Premier candidat NON-webchat avec un destinataire : une session
        // ayant temporairement basculé webchat (reset, message dashboard
        // d'avant l'épinglage) garde ainsi sa route réelle si un candidat
        // plus ancien la porte encore.
        const candidates = [
          entry?.deliveryContext,
          { channel: entry?.lastChannel, to: entry?.lastTo, accountId: entry?.lastAccountId },
          { channel: entry?.origin?.provider, to: entry?.origin?.to, accountId: entry?.origin?.accountId },
        ];
        for (const c of candidates) {
          if (c?.channel && c.channel !== "webchat" && c.to) {
            this.deliveryRoute = { channel: c.channel, to: c.to, accountId: c.accountId ?? undefined };
            break;
          }
        }
      } catch {
        // pas de route connue : deliver:true laissera la gateway décider
      }
    }

    if (!this.supportsMethod("sessions.messages.subscribe")) return;
    try {
      await this.request("sessions.messages.subscribe", { key });
      // Trace de l'abonnement réussi, pour le désabonnement best-effort de stop().
      this.subscribedSessionKey = key;
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
    // Gating de découverte : rejet immédiat plutôt qu'un aller-retour voué au
    // refus. Le LogTailer, lui, s'appuie sur supportsLogs pour ne jamais
    // produire d'erreur répétitive quand logs.tail n'est pas annoncé.
    if (!this.supportsMethod(method)) {
      return Promise.reject(new Error(`méthode ${method} non annoncée par la gateway`));
    }
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

  // Ligne sessions.list (operator.read) de la session principale : porte le
  // couple actif modelProvider/model. Le RPC `status`, lui, réserve ce détail
  // aux clients admin — scope qu'on ne demande plus (voir SCOPES).
  async getMainSessionEntry(): Promise<unknown> {
    if (!this.mainSessionKey) return null;
    const key = this.mainSessionKey;
    const list = (await this.request("sessions.list", {}, 8_000)) as { sessions?: unknown[] } | null;
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    return sessions.find((s) => (s as { key?: unknown } | null)?.key === key) ?? null;
  }

  // agents.list (operator.read) : modèle configuré (primary) et fallbacks de
  // l'agent par défaut, pour distinguer modèle actif et modèle configuré.
  getAgentsSummary(): Promise<unknown> {
    return this.request("agents.list", {}, 8_000);
  }

  // Agent par défaut (première ligne d'agents.list) : id et racine du
  // workspace sur le disque. Sondé en live : { id: "main",
  // workspace: "/Users/claw/.openclaw/workspace", ... }.
  async getDefaultAgent(): Promise<{ id: string; workspace: string | null } | null> {
    if (this.defaultAgentCache) return this.defaultAgentCache;
    const payload = await this.getAgentsSummary();
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { agents?: unknown[] } | null)?.agents)
        ? (payload as { agents: unknown[] }).agents
        : [];
    const first = rows[0] as { id?: unknown; workspace?: unknown } | undefined;
    if (!first || typeof first.id !== "string" || !first.id) return null;
    const workspace =
      typeof first.workspace === "string" && first.workspace.trim() ? first.workspace : null;
    this.defaultAgentCache = { id: first.id, workspace };
    return this.defaultAgentCache;
  }

  // Listing du workspace de l'agent par défaut (chemins RELATIFS ; la racine
  // n'est jamais exposée par ce RPC — confinement fait côté gateway).
  async getWorkspaceListing(path?: string): Promise<unknown> {
    const agent = await this.getDefaultAgent();
    if (!agent) throw new Error("agent par défaut introuvable");
    return this.request(
      "agents.workspace.list",
      { agentId: agent.id, ...(path ? { path } : {}) },
      8_000,
    );
  }

  // Contenu d'un fichier du workspace : { file: { path, name, size,
  // updatedAtMs, mimeType, encoding: "utf8"|"base64", content } }.
  async getWorkspaceFile(path: string): Promise<unknown> {
    const agent = await this.getDefaultAgent();
    if (!agent) throw new Error("agent par défaut introuvable");
    return this.request("agents.workspace.get", { agentId: agent.id, path }, 8_000);
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
    // Route d'origine explicite (originating*, operator.admin — voir SCOPES) :
    // la réponse repart sur le canal réel (ex. WhatsApp) ET la session ne
    // bascule pas « webchat » sous les messages du dashboard. Sans route
    // connue (session née côté webchat), deliver:true laisse la gateway
    // résoudre — elle retombera en interne, et la route se ré-épinglera au
    // prochain message WhatsApp entrant.
    const route = this.deliveryRoute;
    return this.request("chat.send", {
      sessionKey: this.mainSessionKey,
      message: text,
      idempotencyKey: crypto.randomUUID(),
      deliver: true,
      ...(route
        ? {
            originatingChannel: route.channel,
            originatingTo: route.to,
            ...(route.accountId ? { originatingAccountId: route.accountId } : {}),
          }
        : {}),
    });
  }

  // Interrompt le run en cours de la session principale (chat.abort,
  // operator.write — voir SCOPES). Sans runId, la gateway interrompt le run
  // actif de la session. Le gating de découverte est assuré par request().
  abortRun(runId?: string): Promise<unknown> {
    if (!this.mainSessionKey) return Promise.reject(new Error("no active session"));
    return this.request("chat.abort", {
      sessionKey: this.mainSessionKey,
      ...(runId ? { runId } : {}),
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
