// src/checks.ts — sondes de santé HTTP : gateway OpenClaw et Ollama.

export interface HttpCheckResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

// Délai au-delà duquel une dépendance qui traîne est déclarée en échec. Les
// sondes tournent dans un même Promise.all (status.ts) : sans borne, une seule
// dépendance muette figerait tout le cycle de statut.
// Paramétrable UNIQUEMENT pour les tests — éprouver ce délai coûterait sinon
// 3 s de mur par cas (même précédent que relayToNtfy/timeoutMs, notify.ts).
const CHECK_TIMEOUT_MS = 3000;

// Cause d'échec destinée à l'OPÉRATEUR, pas au développeur. Les messages
// d'exception bruts recopiaient du code source dans l'interface — par exemple
// « ((await res.json()).models ?? []).map is not a function » sur une réponse
// Ollama malformée. Une console d'exploitation doit dire ce qui ne va pas,
// pas montrer ses entrailles ; le détail complet reste dans le journal.
function causeLisible(err: unknown): string {
  const nom = err instanceof Error ? err.name : "";
  if (nom === "TimeoutError" || nom === "AbortError") return "délai dépassé";
  if (err instanceof TypeError) {
    // `fetch` lève un TypeError pour toute la famille « connexion
    // impossible » : hôte inconnu, port fermé, TLS refusé.
    return "connexion impossible";
  }
  if (err instanceof SyntaxError) return "réponse illisible (JSON invalide)";
  return "réponse inattendue";
}

async function timedFetch(
  url: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<{ res: Response; latencyMs: number }> {
  const start = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { res, latencyMs: performance.now() - start };
}

/** Vérifie le endpoint de liveness HTTP dédié de la gateway OpenClaw. */
export async function checkGateway(
  url: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<HttpCheckResult> {
  try {
    const { res, latencyMs } = await timedFetch(new URL("/health", url).toString(), timeoutMs);
    // Un statut HTTP en échec doit dire LEQUEL : sans cause, la carte affiche
    // une pastille rouge muette, ce qui n'est pas un diagnostic. checkOllama
    // le faisait déjà, checkGateway non.
    return res.ok
      ? { ok: true, latencyMs: Math.round(latencyMs) }
      : { ok: false, latencyMs: Math.round(latencyMs), error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, latencyMs: null, error: causeLisible(err) };
  }
}

export interface OllamaCheckResult extends HttpCheckResult {
  models?: string[];
  fallbackModelReady?: boolean;
}

export function isOllamaModelReady(models: string[], fallbackModel: string): boolean {
  return models.some((model) => model === fallbackModel);
}

/** Vérifie Ollama via /api/tags et si le modèle de fallback est bien chargé localement. */
export async function checkOllama(
  url: string,
  fallbackModel: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<OllamaCheckResult> {
  let latencyMs: number | null = null;
  try {
    const reponse = await timedFetch(`${url.replace(/\/$/, "")}/api/tags`, timeoutMs);
    // Mémorisée AVANT toute lecture du corps : sur un corps illisible, la
    // latence était perdue alors que l'aller-retour avait bien été mesuré —
    // or c'est précisément le champ qui distingue « injoignable » de
    // « répond mal ».
    latencyMs = Math.round(reponse.latencyMs);
    if (!reponse.res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${reponse.res.status}` };
    }

    const data = (await reponse.res.json()) as unknown;
    // Un corps qui n'est pas un objet (`null`, un tableau, un scalaire) n'est
    // pas une réponse Ollama : rien à en déduire, on le dit.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, latencyMs, error: "réponse illisible (objet attendu)" };
    }
    const brut = (data as { models?: unknown }).models;
    // Schéma inattendu : on ne CONCLUT pas. Rendre une liste vide reviendrait
    // à annoncer « modèle de repli absent », ce qui est un diagnostic — alors
    // qu'on ignore tout de l'état réel. L'échec dit la vraie raison.
    if (brut !== undefined && !Array.isArray(brut)) {
      return { ok: false, latencyMs, error: "réponse illisible (champ « models » inattendu)" };
    }
    // Le contrat annonce `string[]` : on le TIENT. Une liste contenant des
    // objets sans `name` ou des nombres produisait auparavant des `null` et
    // des entiers dans un tableau typé string.
    const models = Array.isArray(brut)
      ? brut
          .map((m) => (m as { name?: unknown } | null)?.name)
          .filter((name): name is string => typeof name === "string" && name.length > 0)
      : [];
    return {
      ok: true,
      latencyMs,
      models,
      fallbackModelReady: isOllamaModelReady(models, fallbackModel),
    };
  } catch (err) {
    return { ok: false, latencyMs, error: causeLisible(err) };
  }
}
