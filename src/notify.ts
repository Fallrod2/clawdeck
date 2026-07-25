// src/notify.ts — notifications entrantes (phase 3) : validation du payload,
// diffusion aux navigateurs connectés et relais vers un topic ntfy privé.
//
// Trois propriétés commandent tout ce fichier :
//
//   - AUCUN historique. Une notification est diffusée aux clients SSE présents
//     à l'instant T, puis oubliée. clawdeck ne persiste que les pings réseau
//     (règle d'or, CLAUDE.md) ; un tampon « des 50 dernières notifications »
//     serait déjà une base de données déguisée, à purger, à borner et à
//     sauvegarder.
//   - DEUX destinataires indépendants. Le navigateur ne voit rien quand
//     l'onglet est fermé, ntfy ne voit rien quand il est injoignable : chacun
//     rapporte son propre sort et la réponse HTTP les distingue, faute de quoi
//     un « 200 OK » global ferait croire qu'un push est parti sur le téléphone
//     alors qu'il s'est perdu.
//   - AUCUN secret dans une erreur ou un log. Le jeton ntfy ne quitte jamais
//     ce module : les échecs sont traduits en constats français avant d'être
//     renvoyés à l'appelant (voir describeNtfyStatus).
//
// Exemple d'appel — jetons et topic factices, à remplacer par ceux de .env :
//
//   curl -X POST http://127.0.0.1:3001/api/notify \
//     -H 'Authorization: Bearer votre-AUTH_TOKEN' \
//     -H 'Content-Type: application/json' \
//     -H 'Idempotency-Key: sauvegarde-2026-07-25' \
//     -d '{"v":1,"title":"Sauvegarde terminée",
//          "message":"12 Go copiés en 4 min.","severity":"info",
//          "tags":["floppy_disk"]}'
//
// Réponses : 200 (relayé ou relais non configuré), 207 (diffusé localement
// mais relais ntfy en échec), 400, 413, 429. Rejouer la MÊME
// Idempotency-Key renvoie la réponse d'origine sans rien réémettre : pour
// réessayer réellement un envoi, changer de clé.

import { logWarn } from "./log";

export const NOTIFY_PAYLOAD_VERSION = 1;

// Bornes de taille. Un titre tient sur une ligne de notification iOS ; le
// corps reste lisible dans une bulle de dashboard sans défilement infini.
// Elles sont volontairement basses : cet endpoint sert des alertes, pas du
// transport de données (le chat, lui, va jusqu'à 8 000 caractères).
export const MAX_TITLE_LENGTH = 120;
export const MAX_MESSAGE_LENGTH = 1_000;
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 24;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
// Enveloppe JSON comprise : 8 Ko laissent de la marge sur les bornes ci-dessus
// tout en refusant un corps déraisonnable avant de le désérialiser.
export const MAX_NOTIFY_BODY_BYTES = 8 * 1024;

// Débit : 20 notifications par minute. Une console d'exploitation en émet
// quelques-unes par heure ; ce plafond n'existe que pour qu'un script en
// boucle ne noie ni le navigateur ni le quota ntfy.
export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

// Courte durée de vie assumée : la clé d'idempotence protège du double envoi
// d'un client qui réessaie après un timeout réseau, pas d'un doublon
// fonctionnel une heure plus tard. Le nombre d'entrées est plafonné parce
// qu'un émetteur qui tire une clé neuve à chaque appel ferait sinon grossir
// cette table sans fin.
export const IDEMPOTENCY_TTL_MS = 60_000;
export const IDEMPOTENCY_MAX_ENTRIES = 128;

// Au-delà, ntfy est considéré injoignable : la requête HTTP entrante ne doit
// pas rester suspendue à un serveur externe muet.
export const NTFY_TIMEOUT_MS = 5_000;

// File d'attente par client SSE. Un navigateur bloqué (onglet gelé, lien
// saturé) ne doit pas faire grossir la mémoire du backend ; au-delà, les plus
// anciennes sont abandonnées ET le client en est informé (voir index.ts) —
// une perte silencieuse serait pire que l'absence de notification.
export const NOTIFY_STREAM_QUEUE_MAX = 50;
// Commentaire SSE périodique : sans trafic, rien ne distingue un flux vivant
// d'une connexion morte, et les notifications sont par nature espacées.
export const NOTIFY_KEEPALIVE_MS = 25_000;

export type NotifySeverity = "info" | "warning" | "error";

const SEVERITIES: readonly NotifySeverity[] = ["info", "warning", "error"];

// Un tag ntfy est un mot-clé ou un nom d'émoji (« warning », « floppy_disk ») :
// l'alphabet strict évite qu'un tag arbitraire finisse dans une requête sortante.
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
// Clé d'idempotence : ASCII imprimable, sans espace. Elle sert de clé de Map
// et se retrouve dans les traces d'un opérateur qui débogue un doublon.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

// --- Payload entrant ---------------------------------------------------------

export interface NotifyInput {
  title: string;
  message: string;
  severity: NotifySeverity;
  tags: string[];
}

export type NotifyErrorCode =
  | "invalid-json"
  | "invalid-payload"
  | "unsupported-version"
  | "invalid-idempotency-key"
  | "body-too-large"
  | "rate-limited";

export type ParseNotifyResult =
  | { ok: true; value: NotifyInput }
  | { ok: false; code: NotifyErrorCode; error: string };

const invalid = (error: string): ParseNotifyResult => ({
  ok: false,
  code: "invalid-payload",
  error,
});

// Les caractères de contrôle traversent JSON sans encombre mais cassent
// l'affichage plus loin (ligne de notification iOS, bulle du dashboard) et
// permettraient d'injecter des sauts de ligne dans un titre. Seul le retour à
// la ligne est toléré, et seulement dans le corps du message.
function hasControlChars(value: string, allowNewline: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a && allowNewline) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseBoundedText(
  raw: unknown,
  field: string,
  maxLength: number,
  allowNewline: boolean,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: `champ « ${field} » requis (chaîne de caractères)` };
  }
  const value = raw.trim();
  if (!value) {
    return { ok: false, error: `champ « ${field} » vide` };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      error: `champ « ${field} » trop long (max ${maxLength} caractères)`,
    };
  }
  if (hasControlChars(value, allowNewline)) {
    return { ok: false, error: `champ « ${field} » : caractères de contrôle interdits` };
  }
  return { ok: true, value };
}

// Validation stricte et exhaustive du corps de POST /api/notify. Pure : elle ne
// diffuse rien, ne relaie rien, et se teste sans serveur (voir notify.test.ts).
export function parseNotifyPayload(raw: unknown): ParseNotifyResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("le corps doit être un objet JSON");
  }
  const body = raw as Record<string, unknown>;

  // Version EXIGÉE, pas déduite : le jour où le format change, un émetteur
  // resté sur l'ancien doit recevoir un refus explicite plutôt que voir ses
  // champs réinterprétés en silence.
  if (typeof body.v !== "number" || !Number.isInteger(body.v)) {
    return invalid(
      `champ « v » requis (version du payload, actuellement ${NOTIFY_PAYLOAD_VERSION})`,
    );
  }
  if (body.v !== NOTIFY_PAYLOAD_VERSION) {
    return {
      ok: false,
      code: "unsupported-version",
      error: `version de payload ${body.v} non supportée (attendu ${NOTIFY_PAYLOAD_VERSION})`,
    };
  }

  const title = parseBoundedText(body.title, "title", MAX_TITLE_LENGTH, false);
  if (!title.ok) return invalid(title.error);
  const message = parseBoundedText(body.message, "message", MAX_MESSAGE_LENGTH, true);
  if (!message.ok) return invalid(message.error);

  let severity: NotifySeverity = "info";
  if (body.severity !== undefined) {
    if (typeof body.severity !== "string" || !SEVERITIES.includes(body.severity as NotifySeverity)) {
      return invalid(`champ « severity » : valeurs acceptées ${SEVERITIES.join(", ")}`);
    }
    severity = body.severity as NotifySeverity;
  }

  const tags: string[] = [];
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      return invalid("champ « tags » : tableau de chaînes attendu");
    }
    if (body.tags.length > MAX_TAGS) {
      return invalid(`champ « tags » : ${MAX_TAGS} entrées au maximum`);
    }
    for (const tag of body.tags) {
      if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
        return invalid(
          `champ « tags » : chaque tag doit correspondre à [A-Za-z0-9_-] (max ${MAX_TAG_LENGTH} caractères)`,
        );
      }
      tags.push(tag);
    }
  }

  return { ok: true, value: { title: title.value, message: message.value, severity, tags } };
}

export function isValidIdempotencyKey(key: string): boolean {
  return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH && IDEMPOTENCY_KEY_PATTERN.test(key);
}

// --- Diffusion aux navigateurs ----------------------------------------------

// Frame envoyée telle quelle sur le flux SSE. Le champ `type` est redondant
// avec le nom d'événement SSE, et c'est volontaire : le front lit le flux via
// fetch et un parseur maison (voir web/src/hooks/useStatusStream.ts) qui
// n'inspecte que les lignes `data:`. Une frame auto-descriptive reste
// interprétable même sans le nom d'événement.
export interface NotificationEvent {
  type: "notification";
  v: typeof NOTIFY_PAYLOAD_VERSION;
  id: string;
  at: number;
  title: string;
  message: string;
  severity: NotifySeverity;
  tags: string[];
}

export type NotificationListener = (event: NotificationEvent) => void;

// Même motif d'abonnement que StatusCollector (subscribe → fonction de
// désabonnement), à une différence près : aucun dernier snapshot n'est rejoué
// à la connexion. Un client qui arrive après coup n'a rien manqué à rattraper,
// il n'existe pas d'historique.
export class NotificationHub {
  private listeners = new Set<NotificationListener>();

  get clientCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Renvoie le nombre de clients servis — c'est ce que la réponse HTTP
  // rapporte à l'appelant, qui saura ainsi qu'aucun navigateur n'était ouvert.
  emit(event: NotificationEvent): number {
    let served = 0;
    for (const listener of this.listeners) {
      try {
        listener(event);
        served++;
      } catch {
        // Un abonné qui lève ne doit pas priver les autres de la notification ;
        // son flux SSE sera de toute façon nettoyé par son propre onAbort.
      }
    }
    return served;
  }
}

// --- Limitation de débit -----------------------------------------------------

// Compteur GLOBAL et non par IP ou par appelant : clawdeck est mono-opérateur
// derrière un unique bearer token (CLAUDE.md), donc une table indexée par
// client n'apporterait rien qu'une occasion de grossir sans borne. La fenêtre
// glissante ne retient au plus que `max` horodatages.
export class RateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const at = this.now();
    const floor = at - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] as number) <= floor) {
      this.hits.shift();
    }
    if (this.hits.length >= this.max) {
      const oldest = this.hits[0] as number;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.windowMs - at) };
    }
    this.hits.push(at);
    return { allowed: true };
  }
}

// --- Idempotence -------------------------------------------------------------

// Mémorise la PROMESSE et non le résultat : deux requêtes portant la même clé
// et parties en parallèle (client qui réessaie avant d'avoir reçu la réponse)
// doivent partager un seul envoi ntfy, pas se croiser sur une table encore vide.
export class IdempotencyStore<T> {
  private entries = new Map<string, { expiresAt: number; result: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async run(
    key: string | null,
    factory: () => Promise<T>,
  ): Promise<{ value: T; replay: boolean }> {
    if (key === null) return { value: await factory(), replay: false };

    this.purgeExpired();
    const existing = this.entries.get(key);
    if (existing) return { value: await existing.result, replay: true };

    const result = factory();
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, result });
    // Un rejet inattendu ne doit pas rester en cache : l'appelant doit pouvoir
    // réessayer avec la même clé après un plantage, pas se voir resservir
    // l'erreur pendant toute la durée de vie de l'entrée.
    result.catch(() => this.entries.delete(key));
    this.evictOverflow();
    return { value: await result, replay: false };
  }

  private purgeExpired(): void {
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key);
    }
  }

  // Map conserve l'ordre d'insertion : la plus ancienne clé part la première.
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

// --- Relais ntfy -------------------------------------------------------------

export interface NtfyConfig {
  // URL du serveur, terminée par « / » : la publication JSON de ntfy se fait
  // sur la racine, le topic voyageant dans le corps (voir relayToNtfy).
  url: string;
  topic: string;
  // Topic privé : jeton d'accès ntfy, absent sur un topic public.
  token: string | null;
}

export type NtfyRelayState = "sent" | "not-configured" | "failed";

export interface NtfyRelayResult {
  state: NtfyRelayState;
  // Constat en français, sans secret ni URL : destiné à l'opérateur qui lit la
  // réponse HTTP ou le panneau de notification.
  detail?: string;
}

export interface NtfyRelayOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// Priorités ntfy : 3 = normale (défaut), 4 = haute, 5 = maximale. Une erreur
// doit contourner le mode « ne pas déranger » de l'iPhone, une info non.
const NTFY_PRIORITY: Record<NotifySeverity, number> = {
  info: 3,
  warning: 4,
  error: 5,
};

// Traduit un code HTTP ntfy en diagnostic actionnable. Le corps de la réponse
// n'est jamais relayé : il pourrait contenir l'écho d'un en-tête d'auth, et un
// code suffit à orienter l'opérateur vers la bonne variable de .env.
function describeNtfyStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "accès refusé par ntfy (vérifier NTFY_TOKEN et les droits du topic)";
  }
  if (status === 404) return "topic ou serveur ntfy introuvable (vérifier NTFY_URL)";
  if (status === 413) return "notification refusée par ntfy : trop volumineuse";
  if (status === 429) return "quota ntfy dépassé";
  if (status >= 500) return `serveur ntfy indisponible (HTTP ${status})`;
  return `ntfy a refusé la publication (HTTP ${status})`;
}

// Publie sur ntfy en JSON sur la RACINE du serveur, et non en texte brut sur
// /<topic> : les en-têtes HTTP (Title, Tags) sont limités à l'ASCII, ce qui
// mutilerait le moindre titre accentué — c'est-à-dire la quasi-totalité des
// notifications d'une interface française.
export async function relayToNtfy(
  config: NtfyConfig | null,
  event: NotificationEvent,
  options: NtfyRelayOptions = {},
): Promise<NtfyRelayResult> {
  // « Non configuré » est un état à part entière, jamais une panne : sans
  // NTFY_URL/NTFY_TOPIC dans .env, il n'y a rien à relayer et rien à réparer.
  if (!config) {
    return { state: "not-configured", detail: "relais ntfy non configuré (voir .env)" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? NTFY_TIMEOUT_MS;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic: config.topic,
        title: event.title,
        message: event.message,
        priority: NTFY_PRIORITY[event.severity],
        ...(event.tags.length > 0 ? { tags: event.tags } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logWarn("notify", "relais ntfy refusé", { statut: res.status });
      return { state: "failed", detail: describeNtfyStatus(res.status) };
    }
    return { state: "sent" };
  } catch (error) {
    // Le message brut reste dans le journal du serveur (il peut nommer l'hôte
    // ou le code réseau), la réponse HTTP n'en reçoit qu'un constat neutre.
    const raison = error instanceof Error ? error.message : String(error);
    logWarn("notify", "relais ntfy injoignable", { raison });
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      state: "failed",
      detail: timedOut
        ? `serveur ntfy sans réponse (délai de ${Math.round(timeoutMs / 1000)} s dépassé)`
        : "serveur ntfy injoignable",
    };
  }
}

// --- Orchestration -----------------------------------------------------------

export interface NotifySuccessBody {
  v: typeof NOTIFY_PAYLOAD_VERSION;
  id: string;
  at: number;
  // true quand la réponse est rejouée depuis la clé d'idempotence : rien n'a
  // été rediffusé ni relayé.
  replay: boolean;
  // `delivered: false` n'est PAS une erreur : sans navigateur connecté il n'y a
  // rien à afficher et rien n'est mis de côté (aucun historique). C'est
  // précisément le cas où le relais ntfy fait tout le travail.
  local: { delivered: boolean; clients: number };
  ntfy: NtfyRelayResult;
}

export interface NotifyErrorBody {
  v: typeof NOTIFY_PAYLOAD_VERSION;
  error: string;
  code: NotifyErrorCode;
  retryAfterSeconds?: number;
}

export interface NotifySubmission {
  // 200 : diffusé et relayé (ou relais non configuré).
  // 207 : diffusé localement, relais ntfy en échec — un 200 masquerait la
  //       moitié perdue, un 502 nierait la moitié réussie.
  status: 200 | 207 | 400 | 429;
  body: NotifySuccessBody | NotifyErrorBody;
  retryAfterSeconds?: number;
}

export interface NotifyServiceOptions {
  hub: NotificationHub;
  // null = relais non configuré, état légitime et explicite.
  ntfy: NtfyConfig | null;
  now?: () => number;
  newId?: () => string;
  fetchImpl?: typeof fetch;
  ntfyTimeoutMs?: number;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  idempotencyTtlMs?: number;
}

export class NotifyService {
  private readonly hub: NotificationHub;
  private readonly ntfy: NtfyConfig | null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly limiter: RateLimiter;
  private readonly idempotency: IdempotencyStore<NotifySubmission>;
  private readonly relayOptions: NtfyRelayOptions;

  constructor(options: NotifyServiceOptions) {
    this.hub = options.hub;
    this.ntfy = options.ntfy;
    this.now = options.now ?? Date.now;
    // randomUUID côté serveur : l'absence de contexte sécurisé qui prive le
    // front de crypto.randomUUID (voir docs/PROJET.md §6) ne concerne que le
    // navigateur.
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.limiter = new RateLimiter(
      options.rateLimitMax ?? RATE_LIMIT_MAX,
      options.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS,
      this.now,
    );
    this.idempotency = new IdempotencyStore<NotifySubmission>(
      options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS,
      IDEMPOTENCY_MAX_ENTRIES,
      this.now,
    );
    this.relayOptions = {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.ntfyTimeoutMs !== undefined ? { timeoutMs: options.ntfyTimeoutMs } : {}),
    };
  }

  async submit(raw: unknown, idempotencyKey: string | null): Promise<NotifySubmission> {
    // Le débit se contrôle AVANT tout le reste, y compris avant la validation :
    // c'est le garde le moins cher, et un émetteur qui boucle sur un payload
    // invalide doit être freiné comme un autre.
    const quota = this.limiter.check();
    if (!quota.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(quota.retryAfterMs / 1000));
      return {
        status: 429,
        retryAfterSeconds,
        body: {
          v: NOTIFY_PAYLOAD_VERSION,
          code: "rate-limited",
          error: `trop de notifications (max ${RATE_LIMIT_MAX} par minute)`,
          retryAfterSeconds,
        },
      };
    }

    if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
      return {
        status: 400,
        body: {
          v: NOTIFY_PAYLOAD_VERSION,
          code: "invalid-idempotency-key",
          error: `en-tête Idempotency-Key invalide (ASCII imprimable, max ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères)`,
        },
      };
    }

    const parsed = parseNotifyPayload(raw);
    if (!parsed.ok) {
      // Une requête malformée n'est jamais mémorisée : la corriger et la
      // renvoyer avec la même clé doit fonctionner.
      return {
        status: 400,
        body: { v: NOTIFY_PAYLOAD_VERSION, code: parsed.code, error: parsed.error },
      };
    }

    const { value, replay } = await this.idempotency.run(idempotencyKey, () =>
      this.dispatch(parsed.value),
    );
    if (!replay) return value;
    // La réponse rejouée est identique à l'originale, au drapeau près : il dit
    // à l'appelant que rien n'est reparti, ni vers le navigateur ni vers ntfy.
    return { ...value, body: { ...(value.body as NotifySuccessBody), replay: true } };
  }

  private async dispatch(input: NotifyInput): Promise<NotifySubmission> {
    const event: NotificationEvent = {
      type: "notification",
      v: NOTIFY_PAYLOAD_VERSION,
      id: this.newId(),
      at: this.now(),
      ...input,
    };
    // Diffusion locale d'abord : elle est synchrone et sans échec possible,
    // alors que le relais peut occuper la requête plusieurs secondes. Le
    // dashboard ouvert affiche donc la notification sans attendre ntfy.
    const clients = this.hub.emit(event);
    const ntfy = await relayToNtfy(this.ntfy, event, this.relayOptions);
    return {
      status: ntfy.state === "failed" ? 207 : 200,
      body: {
        v: NOTIFY_PAYLOAD_VERSION,
        id: event.id,
        at: event.at,
        replay: false,
        local: { delivered: clients > 0, clients },
        ntfy,
      },
    };
  }
}
