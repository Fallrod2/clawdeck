// src/anomalies.ts — journal des anomalies récentes, tenu EN MÉMOIRE.
//
// Raison d'être : une panne transitoire ne laissait aucune trace. La sonde
// retombait au vert, l'incident disparaissait, et le dashboard répondait
// « tout va bien » à quelqu'un qui venait justement demander pourquoi le
// réseau avait lâché cette nuit. Sur une console d'exploitation, savoir qu'une
// liaison a coupé trois fois vaut souvent plus que son état à la seconde près.
//
// La détection est ici, côté backend, et non dans le navigateur : la boucle de
// sondes tourne en continu alors qu'aucun onglet n'est ouvert. Détecter côté
// front n'aurait vu que les pannes survenues pendant qu'on regardait — c'est-à-dire
// exactement celles dont on n'a pas besoin d'un journal pour se souvenir.
//
// Ce journal n'est PAS de la persistance et n'entame pas la règle « rien de ce
// qui vient d'OpenClaw n'est écrit » (CLAUDE.md) : rien ne touche le disque,
// la liste est bornée en nombre ET en âge, et elle repart vide à chaque
// démarrage du backend. Ce dernier point n'est pas un détail à cacher : le
// payload transporte `since` pour que l'interface annonce la fenêtre réellement
// observée au lieu de laisser croire à un historique complet.
//
// Ce que ce module refuse d'affirmer :
//   - qu'il a tout vu — un redémarrage du backend, une collecte qui échoue en
//     bloc ou un incident plus vieux que la rétention n'y figurent pas ;
//   - qu'une entrée résolue l'est à la seconde : la fin est datée du premier
//     cycle de sonde qui ne voit plus l'anomalie, à un intervalle de poll près ;
//   - qu'une anomalie de sonde est une panne du service sondé — on journalise
//     ce qui a été mesuré, avec les mots de la mesure.

export type AnomalySeverity = "warning" | "critical";

/** Fenêtre de regroupement d'un rebond (identique à celle du chat, timeline.ts) :
 *  une même anomalie qui revient après moins de 5 minutes de vert prolonge
 *  l'entrée existante au lieu d'en créer une nouvelle. C'est ce qui empêche une
 *  sonde qui clignote de noyer la liste — et le compteur d'occurrences dit
 *  bien plus qu'une pile de lignes identiques. */
export const REGROUP_WINDOW_MS = 5 * 60_000;

/** Au-delà, une anomalie résolue sort du journal. La question à laquelle ce
 *  bandeau répond est « qu'est-ce qui a lâché cette nuit », pas « depuis
 *  toujours » — même période que la vue par défaut du graphe de latence. */
export const RETENTION_MS = 24 * 60 * 60_000;

/** Borne dure de la liste. Cinq sous-systèmes seulement peuvent être en
 *  anomalie simultanément : ce plafond ne tronque donc jamais un incident en
 *  cours, seulement les plus anciennes entrées déjà résolues. */
export const MAX_ENTRIES = 12;

/** Les détails viennent de messages d'erreur arbitraires (fetch, RPC). Ils sont
 *  conservés jusqu'à 24 h et re-sérialisés dans CHAQUE instantané SSE, toutes
 *  les 5 s : leur longueur se borne à la source, pas à l'affichage. */
const MAX_DETAIL_CHARS = 140;

export interface AnomalySignal {
  /** Sous-système + nature exacte : c'est la clé de regroupement. Un même
   *  sous-système qui tombe pour une raison DIFFÉRENTE ouvre une autre entrée,
   *  parce que « HTTP injoignable » et « liaison de contrôle rompue » sont deux
   *  constats distincts, pas deux occurrences du même. */
  key: string;
  /** Micro-libellé de catégorie, tel qu'affiché. */
  scope: string;
  severity: AnomalySeverity;
  /** Constat en une ligne. */
  label: string;
  /** Cause courte quand elle est connue, chaîne vide sinon. */
  detail: string;
}

export interface AnomalyEntry extends AnomalySignal {
  /** Première observation, regroupement des rebonds compris. */
  startedAt: number;
  /** Dernière observation de l'anomalie elle-même. */
  lastSeenAt: number;
  /** Premier cycle qui ne la voit plus, ou null tant qu'elle est observée. */
  endedAt: number | null;
  /** Survenues regroupées sous cette entrée (1 = incident continu). */
  occurrences: number;
}

export interface AnomalyJournalPayload {
  /** Début d'observation = démarrage du backend. */
  since: number;
  /** La rétention voyage avec le journal : l'interface annonce la fenêtre
   *  réellement couverte sans dupliquer une constante du backend. */
  retentionMs: number;
  /** Les plus récentes d'abord, en cours avant résolues. */
  entries: AnomalyEntry[];
}

/** Sous-ensemble d'un instantané de statut dont dépend la détection. Décrit
 *  structurellement plutôt qu'importé de `status.ts` : le module reste
 *  testable avec quatre champs au lieu d'un payload complet, et les deux
 *  fichiers ne s'importent pas mutuellement. */
export interface AnomalyInputs {
  gateway: { ok: boolean; error?: string };
  openclaw: {
    connected: boolean;
    healthy: boolean | null;
    provider: string | null;
    model: string | null;
    configuredModel: string | null;
    usingFallback: boolean | null;
    modelAvailable: boolean | null;
    whatsapp: { healthy: boolean | null; healthState: string | null; lastError: string | null };
    error?: string;
  };
  ollama: { ok: boolean; error?: string; fallbackModelReady?: boolean };
  network: { severity: "good" | "warning" | "critical"; verdict: string; headline: string; silentHosts: string[] };
}

function clampDetail(detail: string | null | undefined): string {
  const trimmed = detail?.trim() ?? "";
  if (trimmed.length <= MAX_DETAIL_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function signal(
  key: string,
  scope: string,
  severity: AnomalySeverity,
  label: string,
  detail?: string | null,
): AnomalySignal {
  return { key, scope, severity, label, detail: clampDetail(detail) };
}

/** Anomalie de la liaison de contrôle. Un seul signal, alors que trois champs
 *  peuvent être rouges en même temps : quand la gateway tombe, sa sonde HTTP,
 *  son WebSocket et sa santé RPC s'éteignent ENSEMBLE. Trois entrées pour un
 *  seul incident feraient passer une panne pour une avarie générale. */
function gatewaySignal(inputs: AnomalyInputs): AnomalySignal | null {
  if (!inputs.gateway.ok) {
    return signal(
      "gateway:http",
      "Gateway",
      "critical",
      "Gateway OpenClaw injoignable",
      inputs.gateway.error ?? "La sonde HTTP n'a pas abouti.",
    );
  }
  if (!inputs.openclaw.connected) {
    return signal(
      "gateway:rpc",
      "Gateway",
      "critical",
      "Liaison de contrôle OpenClaw rompue",
      "Le service HTTP répond, le WebSocket de contrôle n'est pas établi.",
    );
  }
  if (inputs.openclaw.healthy === false) {
    return signal(
      "gateway:sante",
      "Gateway",
      "critical",
      "OpenClaw se déclare en mauvaise santé",
      inputs.openclaw.error ?? "Le contrôle de santé RPC répond négativement.",
    );
  }
  return null;
}

/** Le verdict réseau, pas les trois sondes : network-diagnosis.ts existe
 *  précisément parce que trois pastilles rouges ne sont pas trois incidents.
 *  Le journal hérite de cette conclusion déjà testée. */
function networkSignal(inputs: AnomalyInputs): AnomalySignal | null {
  const { network } = inputs;
  if (network.severity === "good") return null;
  const silent = network.silentHosts;
  return signal(
    `network:${network.verdict}`,
    "Réseau",
    network.severity,
    network.headline,
    silent.length ? `Muet${silent.length > 1 ? "s" : ""} : ${silent.join(", ")}.` : null,
  );
}

function modelSignal(inputs: AnomalyInputs): AnomalySignal | null {
  const { provider, model, configuredModel, usingFallback, modelAvailable } = inputs.openclaw;
  const activeRef = provider && model ? `${provider}/${model}` : model;
  if (modelAvailable === false) {
    return signal(
      "modele:indisponible",
      "Modèle",
      "critical",
      "Modèle actif indisponible",
      activeRef ? `${activeRef} est sélectionné mais n'est pas disponible.` : null,
    );
  }
  if (usingFallback === true) {
    return signal(
      "modele:repli",
      "Modèle",
      "warning",
      "Bascule sur le modèle de repli",
      activeRef && configuredModel ? `${activeRef} au lieu de ${configuredModel}.` : null,
    );
  }
  return null;
}

function whatsappSignal(inputs: AnomalyInputs): AnomalySignal | null {
  const { whatsapp } = inputs.openclaw;
  // `null` = état inconnu (gateway muette, canal non configuré) : une absence
  // de mesure n'est pas une anomalie, et l'inscrire au journal ferait d'une
  // coupure de gateway une avalanche de fausses pannes de canal.
  if (whatsapp.healthy !== false) return null;
  return signal(
    "whatsapp:sante",
    "WhatsApp",
    "critical",
    "Canal WhatsApp interrompu",
    whatsapp.lastError ??
      (whatsapp.healthState
        ? `État signalé par OpenClaw : ${whatsapp.healthState}.`
        : "Le compte n'est plus lié, actif ou connecté."),
  );
}

/** Ollama garde la sévérité de sa carte de statut : injoignable = indisponible,
 *  modèle absent = dégradé. Un journal qui classerait le même fait autrement
 *  que la carte juste en dessous ferait douter des deux. */
function ollamaSignal(inputs: AnomalyInputs): AnomalySignal | null {
  if (!inputs.ollama.ok) {
    return signal(
      "ollama:injoignable",
      "Ollama",
      "critical",
      "Ollama injoignable",
      inputs.ollama.error ?? "La sonde HTTP n'a pas abouti.",
    );
  }
  if (inputs.ollama.fallbackModelReady === false) {
    return signal(
      "ollama:modele",
      "Ollama",
      "warning",
      "Modèle de repli absent d'Ollama",
      "Ollama répond, mais le modèle de repli configuré n'est pas chargé.",
    );
  }
  return null;
}

/**
 * Anomalies présentes dans un instantané. Fonction pure et totale : au plus un
 * signal par sous-système, dans l'ordre où ils comptent pour l'exploitation.
 * Un instantané sain renvoie une liste vide.
 */
export function readAnomalySignals(inputs: AnomalyInputs): AnomalySignal[] {
  return [
    gatewaySignal(inputs),
    networkSignal(inputs),
    modelSignal(inputs),
    whatsappSignal(inputs),
    ollamaSignal(inputs),
  ].filter((candidate): candidate is AnomalySignal => candidate !== null);
}

function compareEntries(a: AnomalyEntry, b: AnomalyEntry): number {
  // En cours d'abord : une anomalie qui dure prime sur une qui vient de finir,
  // même horodatage identique.
  const aOpen = a.endedAt === null;
  const bOpen = b.endedAt === null;
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const recency = (b.endedAt ?? b.lastSeenAt) - (a.endedAt ?? a.lastSeenAt);
  if (recency !== 0) return recency;
  if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
  // Départage final sur la clé : l'ordre doit être stable d'un cycle à l'autre,
  // sinon les lignes permuteraient toutes seules à chaque instantané SSE.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Entrée susceptible d'accueillir ce signal : la plus récente parmi celles de
 *  même clé encore ouvertes ou refermées depuis moins que la fenêtre. */
function regroupTarget(
  entries: AnomalyEntry[],
  key: string,
  now: number,
): AnomalyEntry | null {
  let best: AnomalyEntry | null = null;
  for (const entry of entries) {
    if (entry.key !== key) continue;
    if (entry.endedAt !== null && now - entry.endedAt > REGROUP_WINDOW_MS) continue;
    if (!best || entry.lastSeenAt > best.lastSeenAt) best = entry;
  }
  return best;
}

/**
 * Applique une mesure au journal. Fonction pure : l'état précédent n'est jamais
 * modifié, une nouvelle liste est renvoyée — c'est ce qui rend le comportement
 * de rebond vérifiable en repliant une suite de mesures dans un test.
 *
 * Le retour au vert ne SUPPRIME pas l'entrée, il la date : c'est tout l'objet
 * du journal.
 */
export function foldAnomalies(
  previous: readonly AnomalyEntry[],
  signals: readonly AnomalySignal[],
  now: number,
): AnomalyEntry[] {
  const entries = previous.map((entry) => ({ ...entry }));
  const observed = new Set<string>();

  for (const current of signals) {
    observed.add(current.key);
    const target = regroupTarget(entries, current.key, now);
    if (!target) {
      entries.push({ ...current, startedAt: now, lastSeenAt: now, endedAt: null, occurrences: 1 });
      continue;
    }
    // Rebond : l'anomalie était refermée et revient dans la fenêtre. On compte
    // une survenue de plus et on garde `startedAt`, pour lire « depuis 03:42,
    // 7 fois » plutôt que sept lignes qui perdent le début de l'épisode.
    if (target.endedAt !== null) target.occurrences += 1;
    target.endedAt = null;
    target.lastSeenAt = now;
    target.severity = current.severity;
    target.label = current.label;
    target.detail = current.detail;
  }

  for (const entry of entries) {
    if (entry.endedAt === null && !observed.has(entry.key)) entry.endedAt = now;
  }

  return entries
    .filter((entry) => entry.endedAt === null || now - entry.endedAt <= RETENTION_MS)
    .sort(compareEntries)
    .slice(0, MAX_ENTRIES);
}

export interface AnomalyJournal {
  /** Applique une mesure et renvoie le journal à diffuser. */
  observe(inputs: AnomalyInputs, now: number): AnomalyJournalPayload;
}

/**
 * Journal borné, sans aucune écriture disque. L'état mutable se limite à cette
 * liste ; toute la décision vit dans `readAnomalySignals` et `foldAnomalies`,
 * qui restent pures.
 */
export function createAnomalyJournal(startedAt = Date.now()): AnomalyJournal {
  let entries: AnomalyEntry[] = [];

  return {
    observe(inputs, now) {
      entries = foldAnomalies(entries, readAnomalySignals(inputs), now);
      return { since: startedAt, retentionMs: RETENTION_MS, entries };
    },
  };
}
