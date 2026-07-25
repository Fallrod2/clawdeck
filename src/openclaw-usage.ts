// src/openclaw-usage.ts — usage et quota d'OpenClaw, normalisés pour l'UI.
//
// Deux RPC répondent à deux questions différentes, et ce module les garde
// séparées parce qu'elles ne tombent pas en panne ensemble :
//   - `usage.status` dit ce que les FOURNISSEURS déclarent (fenêtres de
//     limitation, crédits). Chaque appel part en HTTP chez eux, sans cache
//     côté OpenClaw : c'est la donnée qui coûte cher à rafraîchir.
//   - `usage.cost` dit ce qu'OpenClaw a MESURÉ localement en relisant ses
//     transcriptions (jetons et coût). Gratuit, mais parfois incomplet le
//     temps que son cache de calcul soit reconstruit.
// Les fusionner sous un seul état ferait passer une panne de réseau chez le
// fournisseur pour une absence de consommation, et inversement.
//
// Rien de ce qui identifie un compte ne traverse ce module. Les réponses
// d'usage d'OpenClaw portent aussi des clés de session, des libellés de
// contact et des origines de canal (numéros WhatsApp) — c'est le cas de
// `sessions.usage`, délibérément non consommé. On ne recopie ici que des
// agrégats et des libellés de fenêtre.

/**
 * État d'un bloc d'usage. Les cinq cas sont opérationnellement distincts et
 * l'affichage ne doit jamais les confondre :
 *  - `ready`       : chiffres exploitables ;
 *  - `empty`       : la mesure a abouti et il n'y a rien à montrer (aucun
 *                    fournisseur ne déclare de quota, ou aucune activité sur
 *                    la fenêtre) — ce n'est pas une panne ;
 *  - `pending`     : rien n'a encore été mesuré (premier cycle, ou cache de
 *                    coût en cours de reconstruction). Les chiffres présents
 *                    valent zéro par construction, pas par constat ;
 *  - `unsupported` : cette gateway n'annonce pas la méthode. Inutile de
 *                    réessayer ou d'attendre : il n'y aura jamais de donnée ;
 *  - `error`       : l'appel a échoué, il peut réussir au cycle suivant.
 */
export type OpenClawUsageState = "ready" | "empty" | "pending" | "unsupported" | "error";

/** Fraîcheur du calcul de coût, telle qu'OpenClaw la déclare sur son cache. */
export type OpenClawCostFreshness = "fresh" | "partial" | "stale" | "refreshing";

/** Fenêtre de limitation déclarée par un fournisseur (« 5h », « Week »…). */
export interface OpenClawUsageWindow {
  label: string;
  /** Consommé, en pourcentage borné à [0, 100]. */
  usedPercent: number;
  /** Remise à zéro annoncée, en ms epoch ; null si le fournisseur se tait. */
  resetAt: number | null;
}

/**
 * Fait monétaire ou de crédits déclaré par un fournisseur. Les trois formes
 * d'OpenClaw (solde, dépense, budget) sont aplaties en une seule pour que
 * l'affichage n'ait pas à discriminer une union : `kind` dit lesquels des
 * champs chiffrés sont renseignés.
 */
export interface OpenClawUsageBalance {
  kind: "balance" | "spend" | "budget";
  label: string | null;
  /** Renseigné pour `balance` et `spend`. */
  amount: number | null;
  /** Renseignés pour `budget`. */
  used: number | null;
  limit: number | null;
  /** Devise ISO ou unité propre au fournisseur (« credits »…). */
  unit: string;
  period: string | null;
  resetAt: number | null;
}

export interface OpenClawUsageProvider {
  /** Identifiant normalisé côté OpenClaw : « openai », « anthropic »… */
  id: string;
  displayName: string;
  /** Palier d'abonnement déclaré par le fournisseur, quand il l'expose. */
  plan: string | null;
  windows: OpenClawUsageWindow[];
  balances: OpenClawUsageBalance[];
  /**
   * Fenêtre la plus consommée. C'est elle qui décide du moment où l'agent
   * sera bloqué — ni la moyenne, ni la première déclarée.
   */
  worstUsedPercent: number | null;
  /** Erreur propre à ce fournisseur (jeton expiré, HTTP 429…). */
  error: string | null;
}

/** Quotas déclarés par les fournisseurs (RPC `usage.status`). */
export interface OpenClawQuotaUsage {
  state: OpenClawUsageState;
  /** Horodatage de la mesure, produit par OpenClaw et non par nous. */
  measuredAt: number | null;
  providers: OpenClawUsageProvider[];
  error: string | null;
}

/**
 * Coût et jetons mesurés localement par OpenClaw (RPC `usage.cost`).
 *
 * Aucune devise n'est exposée : le RPC n'en renvoie pas. `totalCost` est une
 * valorisation calculée par OpenClaw depuis sa table de tarifs, pas une
 * facture — l'affichage ne doit pas lui coller un symbole monétaire qu'il ne
 * peut pas justifier.
 */
export interface OpenClawCostUsage {
  state: OpenClawUsageState;
  /** Fenêtre effectivement couverte, en jours, telle qu'OpenClaw la renvoie. */
  windowDays: number;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Entrées dont le tarif est inconnu : `totalCost` est alors un plancher. */
  missingCostEntries: number;
  freshness: OpenClawCostFreshness | null;
  measuredAt: number | null;
  error: string | null;
}

export interface OpenClawUsage {
  quota: OpenClawQuotaUsage;
  cost: OpenClawCostUsage;
}

/**
 * Ce que le lecteur attend de la gateway. `null` signifie « méthode non
 * annoncée par cette gateway » et se distingue d'une exception, qui signale
 * un appel parti et échoué.
 */
export interface OpenClawUsageSource {
  getUsageStatus(): Promise<unknown | null>;
  getUsageCost(days?: number): Promise<unknown | null>;
}

export interface OpenClawUsageReader {
  read(source: OpenClawUsageSource): Promise<OpenClawUsage>;
}

export interface OpenClawUsageReaderOptions {
  minIntervalMs?: number;
  costWindowDays?: number;
  now?: () => number;
}

// Intervalle minimal entre deux lectures réelles. Il ne ménage pas la gateway
// mais les FOURNISSEURS : `usage.status` déclenche à chaque appel une requête
// sortante vers chatgpt.com ou api.anthropic.com, qu'OpenClaw ne met pas en
// cache. Au rythme de la boucle de statut, on frapperait ces endpoints
// plusieurs milliers de fois par jour pour une donnée dont les fenêtres se
// comptent en heures.
const USAGE_MIN_INTERVAL_MS = 60_000;

// Fenêtre de coût par défaut. Un mois glissant donne un ordre de grandeur
// stable ; une fenêtre courte ferait osciller le chiffre d'un cycle à l'autre
// sans rien apprendre sur la tendance.
const COST_WINDOW_DAYS = 30;

const COST_FRESHNESS: readonly OpenClawCostFreshness[] = ["fresh", "partial", "stale", "refreshing"];

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWindow(value: unknown): OpenClawUsageWindow | null {
  const row = record(value);
  const label = stringValue(row?.label);
  const usedPercent = numberValue(row?.usedPercent);
  // Une fenêtre sans libellé ou sans pourcentage n'est pas affichable ; la
  // taire vaut mieux que rendre une barre de progression sans échelle.
  if (!label || usedPercent === null) return null;
  return {
    label,
    // Re-borné ici aussi : le contrat « 0-100 » doit tenir même si une version
    // de gateway laisse passer une valeur hors bornes.
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetAt: numberValue(row?.resetAt),
  };
}

function normalizeBalance(value: unknown): OpenClawUsageBalance | null {
  const row = record(value);
  const kind = stringValue(row?.type);
  const unit = stringValue(row?.unit);
  if (unit === null || (kind !== "balance" && kind !== "spend" && kind !== "budget")) return null;
  const amount = numberValue(row?.amount);
  const used = numberValue(row?.used);
  const limit = numberValue(row?.limit);
  // Un poste sans chiffre exploitable n'apprend rien : on le laisse tomber
  // plutôt que d'afficher une ligne de solde vide.
  if (kind === "budget" ? used === null || limit === null : amount === null) return null;
  return {
    kind,
    label: stringValue(row?.label),
    amount,
    used,
    limit,
    unit,
    period: stringValue(row?.period),
    resetAt: numberValue(row?.resetAt),
  };
}

function normalizeProvider(value: unknown): OpenClawUsageProvider | null {
  const row = record(value);
  const id = stringValue(row?.provider);
  if (!id) return null;
  const windows = rows(row?.windows)
    .map(normalizeWindow)
    .filter((window): window is OpenClawUsageWindow => window !== null);
  const balances = rows(row?.billing)
    .map(normalizeBalance)
    .filter((balance): balance is OpenClawUsageBalance => balance !== null);
  return {
    id,
    displayName: stringValue(row?.displayName) ?? id,
    plan: stringValue(row?.plan),
    windows,
    balances,
    worstUsedPercent: windows.length
      ? Math.max(...windows.map((window) => window.usedPercent))
      : null,
    error: stringValue(row?.error),
  };
}

/** Normalise la charge de `usage.status`. Fonction totale : toute forme inattendue retombe sur « vide ». */
export function normalizeQuotaUsage(payload: unknown): OpenClawQuotaUsage {
  const root = record(payload);
  const providers = rows(root?.providers)
    .map(normalizeProvider)
    .filter((provider): provider is OpenClawUsageProvider => provider !== null);
  return {
    // Un fournisseur qui ne renvoie qu'une erreur reste une donnée à
    // afficher : l'état d'ensemble dit que l'appel a abouti, et l'erreur
    // voyage dans la ligne du fournisseur concerné.
    state: providers.length > 0 ? "ready" : "empty",
    measuredAt: numberValue(root?.updatedAt),
    providers,
    error: null,
  };
}

/** Normalise la charge de `usage.cost`. Fonction totale, comme ci-dessus. */
export function normalizeCostUsage(payload: unknown, windowDays: number): OpenClawCostUsage {
  const root = record(payload);
  const totals = record(root?.totals);
  const cacheStatus = record(root?.cacheStatus);
  const rawFreshness = stringValue(cacheStatus?.status);
  const freshness = COST_FRESHNESS.find((candidate) => candidate === rawFreshness) ?? null;
  const cachedFiles = numberValue(cacheStatus?.cachedFiles);
  const totalTokens = numberValue(totals?.totalTokens) ?? 0;
  const totalCost = numberValue(totals?.totalCost) ?? 0;

  // « Pas encore mesuré » ≠ « rien à mesurer ». Tant qu'OpenClaw n'a aucun
  // fichier de transcription exploitable en cache ET se déclare en travail,
  // les totaux valent zéro par construction : les afficher ferait passer un
  // calcul inachevé pour une consommation nulle. Un cache « fresh » sans
  // fichier, lui, décrit bien une fenêtre réellement sans activité.
  const notMeasuredYet = cachedFiles === 0 && freshness !== null && freshness !== "fresh";
  const state: OpenClawUsageState = notMeasuredYet
    ? "pending"
    : totalTokens === 0 && totalCost === 0
      ? "empty"
      : "ready";

  return {
    state,
    // La fenêtre annoncée par OpenClaw prime sur celle qu'on a demandée : lui
    // seul sait ce qu'il a réellement couvert.
    windowDays: numberValue(root?.days) ?? windowDays,
    totalCost,
    totalTokens,
    inputTokens: numberValue(totals?.input) ?? 0,
    outputTokens: numberValue(totals?.output) ?? 0,
    cacheReadTokens: numberValue(totals?.cacheRead) ?? 0,
    cacheWriteTokens: numberValue(totals?.cacheWrite) ?? 0,
    missingCostEntries: numberValue(totals?.missingCostEntries) ?? 0,
    freshness,
    measuredAt: numberValue(root?.updatedAt),
    error: null,
  };
}

function emptyCost(state: OpenClawUsageState, error: string | null, windowDays: number): OpenClawCostUsage {
  return {
    state,
    windowDays,
    totalCost: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingCostEntries: 0,
    freshness: null,
    measuredAt: null,
    error,
  };
}

/** Usage dont rien n'a encore été lu — à distinguer d'une gateway qui ne sait pas répondre. */
export function pendingOpenClawUsage(): OpenClawUsage {
  return {
    quota: { state: "pending", measuredAt: null, providers: [], error: null },
    cost: emptyCost("pending", null, COST_WINDOW_DAYS),
  };
}

async function readQuota(source: OpenClawUsageSource): Promise<OpenClawQuotaUsage> {
  try {
    const payload = await source.getUsageStatus();
    if (payload === null) {
      return { state: "unsupported", measuredAt: null, providers: [], error: null };
    }
    return normalizeQuotaUsage(payload);
  } catch (error) {
    return { state: "error", measuredAt: null, providers: [], error: errorMessage(error) };
  }
}

async function readCost(source: OpenClawUsageSource, windowDays: number): Promise<OpenClawCostUsage> {
  try {
    const payload = await source.getUsageCost(windowDays);
    if (payload === null) return emptyCost("unsupported", null, windowDays);
    return normalizeCostUsage(payload, windowDays);
  } catch (error) {
    return emptyCost("error", errorMessage(error), windowDays);
  }
}

/**
 * Lecteur d'usage étranglé dans le temps. L'étranglement fait partie du
 * contrat et non de l'optimisation : sans lui, brancher l'usage sur la boucle
 * de statut reviendrait à sonder les fournisseurs en continu.
 */
export function createOpenClawUsageReader(
  options: OpenClawUsageReaderOptions = {},
): OpenClawUsageReader {
  const minIntervalMs = options.minIntervalMs ?? USAGE_MIN_INTERVAL_MS;
  const costWindowDays = options.costWindowDays ?? COST_WINDOW_DAYS;
  const now = options.now ?? Date.now;
  let cached: OpenClawUsage | null = null;
  let cachedAt = 0;
  let inFlight: Promise<OpenClawUsage> | null = null;

  return {
    read(source) {
      // Une lecture en vol est partagée plutôt que doublée : deux cycles de
      // collecte qui se chevauchent ne doivent pas produire deux appels
      // sortants vers les fournisseurs.
      if (inFlight) return inFlight;
      if (cached && now() - cachedAt < minIntervalMs) return Promise.resolve(cached);
      const pending = Promise.all([readQuota(source), readCost(source, costWindowDays)])
        .then(([quota, cost]): OpenClawUsage => {
          // Le résultat est mémorisé tel quel, succès comme échec : un
          // fournisseur en panne ne doit pas être re-sondé à chaque cycle.
          // L'âge reste lisible par `measuredAt`, qui vient d'OpenClaw et non
          // de cette horloge — une valeur resservie ne se rajeunit jamais.
          const usage = { quota, cost };
          cached = usage;
          cachedAt = now();
          return usage;
        })
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        });
      inFlight = pending;
      return pending;
    },
  };
}
