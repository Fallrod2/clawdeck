// src/checks.ts — sondes de santé HTTP : gateway OpenClaw et Ollama.

export interface HttpCheckResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

async function timedFetch(
  url: string,
  timeoutMs = 3000,
): Promise<{ res: Response; latencyMs: number }> {
  const start = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { res, latencyMs: performance.now() - start };
}

/** Vérifie le endpoint de liveness HTTP dédié de la gateway OpenClaw. */
export async function checkGateway(url: string): Promise<HttpCheckResult> {
  try {
    const { res, latencyMs } = await timedFetch(new URL("/health", url).toString());
    return { ok: res.ok, latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { ok: false, latencyMs: null, error: (err as Error).message };
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
): Promise<OllamaCheckResult> {
  try {
    const { res, latencyMs } = await timedFetch(
      `${url.replace(/\/$/, "")}/api/tags`,
    );
    if (!res.ok) {
      return {
        ok: false,
        latencyMs: Math.round(latencyMs),
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    return {
      ok: true,
      latencyMs: Math.round(latencyMs),
      models,
      fallbackModelReady: isOllamaModelReady(models, fallbackModel),
    };
  } catch (err) {
    return { ok: false, latencyMs: null, error: (err as Error).message };
  }
}
