// src/openclaw-status.ts — normalisation des RPC OpenClaw vers un contrat UI
// stable et sans données sensibles.

export interface OpenClawStatusSource {
  readonly isConnected: boolean;
  readonly version: string | null;
  readonly uptimeMs: number | null;
  readonly mainSessionKey: string | null;
  getHealthSnapshot(): Promise<unknown>;
  getStatusSummary(): Promise<unknown>;
  getWhatsAppStatus(): Promise<unknown>;
  getConfiguredModels(): Promise<unknown>;
}

export interface OpenClawRuntimeStatus {
  connected: boolean;
  healthy: boolean | null;
  version: string | null;
  uptimeMs: number | null;
  healthTimestamp: number | null;
  healthDurationMs: number | null;
  provider: string | null;
  model: string | null;
  configuredModel: string | null;
  usingFallback: boolean | null;
  modelAvailable: boolean | null;
  whatsapp: {
    configured: boolean | null;
    linked: boolean | null;
    running: boolean | null;
    connected: boolean | null;
    healthy: boolean | null;
    healthState: string | null;
    lastActivityAt: number | null;
    lastError: string | null;
  };
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function splitModelRef(value: string | null): { provider: string | null; model: string | null } {
  if (!value) return { provider: null, model: null };
  const separator = value.indexOf("/");
  if (separator < 1) return { provider: null, model: value };
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1) || null,
  };
}

function settledValue(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "fulfilled" ? result.value : null;
}

function settledErrors(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    return [result.reason instanceof Error ? result.reason.message : String(result.reason)];
  });
}

function emptyWhatsapp(): OpenClawRuntimeStatus["whatsapp"] {
  return {
    configured: null,
    linked: null,
    running: null,
    connected: null,
    healthy: null,
    healthState: null,
    lastActivityAt: null,
    lastError: null,
  };
}

export function unavailableOpenClawRuntime(
  source: Pick<OpenClawStatusSource, "version" | "uptimeMs">,
  error = "gateway control connection unavailable",
): OpenClawRuntimeStatus {
  return {
    connected: false,
    healthy: false,
    version: source.version,
    uptimeMs: source.uptimeMs,
    healthTimestamp: null,
    healthDurationMs: null,
    provider: null,
    model: null,
    configuredModel: null,
    usingFallback: null,
    modelAvailable: null,
    whatsapp: emptyWhatsapp(),
    error,
  };
}

export async function readOpenClawRuntime(
  source: OpenClawStatusSource,
): Promise<OpenClawRuntimeStatus> {
  if (!source.isConnected) {
    return unavailableOpenClawRuntime(source);
  }

  const results = await Promise.allSettled([
    source.getHealthSnapshot(),
    source.getStatusSummary(),
    source.getWhatsAppStatus(),
    source.getConfiguredModels(),
  ]);
  const health = record(settledValue(results[0]!));
  const status = record(settledValue(results[1]!));
  const channels = record(settledValue(results[2]!));
  const modelsPayload = record(settledValue(results[3]!));

  const sessions = record(status?.sessions);
  const recent = Array.isArray(sessions?.recent) ? sessions.recent.map(record).filter(Boolean) : [];
  const activeSession = recent.find((entry) => entry?.key === source.mainSessionKey) ?? recent[0] ?? null;
  const selectedRef =
    stringValue(activeSession?.selectedModel) ??
    stringValue(activeSession?.configuredModel) ??
    stringValue(activeSession?.model);
  const selected = splitModelRef(selectedRef);
  const configuredModel = stringValue(activeSession?.configuredModel);
  const configured = splitModelRef(configuredModel);

  const models = Array.isArray(modelsPayload?.models)
    ? modelsPayload.models.map(record).filter(Boolean)
    : [];
  const modelEntry = models.find((entry) => {
    const provider = stringValue(entry?.provider);
    const id = stringValue(entry?.id);
    return id === selected.model && (!selected.provider || provider === selected.provider);
  });
  const provider = selected.provider ?? stringValue(modelEntry?.provider) ?? configured.provider;

  const channelMap = record(channels?.channels);
  const channelAccounts = record(channels?.channelAccounts);
  const whatsappSummary = record(channelMap?.whatsapp);
  const whatsappAccounts = Array.isArray(channelAccounts?.whatsapp)
    ? channelAccounts.whatsapp.map(record).filter(Boolean)
    : [];
  const whatsappAccount = whatsappAccounts[0] ?? null;
  const configuredWhatsApp =
    booleanValue(whatsappAccount?.configured) ?? booleanValue(whatsappSummary?.configured);
  const linked = booleanValue(whatsappAccount?.linked) ?? booleanValue(whatsappSummary?.linked);
  const running = booleanValue(whatsappAccount?.running) ?? booleanValue(whatsappSummary?.running);
  const connected = booleanValue(whatsappAccount?.connected) ?? booleanValue(whatsappSummary?.connected);
  const healthState =
    stringValue(whatsappAccount?.healthState) ?? stringValue(whatsappSummary?.healthState);
  const lastError =
    stringValue(whatsappAccount?.lastError) ?? stringValue(whatsappSummary?.lastError);
  const activityCandidates = [
    whatsappAccount?.lastInboundAt,
    whatsappAccount?.lastOutboundAt,
    whatsappSummary?.lastInboundAt,
    whatsappSummary?.lastOutboundAt,
    whatsappSummary?.lastMessageAt,
    whatsappSummary?.lastEventAt,
  ].map(numberValue).filter((value): value is number => value !== null);
  const whatsappHealthy = configuredWhatsApp === null || linked === null || running === null || connected === null
    ? null
    : configuredWhatsApp && linked && running && connected && healthState !== "unhealthy" && !lastError;

  const errors = [...new Set(settledErrors(results))];
  const selectedNormalized = selectedRef?.toLowerCase() ?? null;
  const configuredNormalized = configuredModel?.toLowerCase() ?? null;

  return {
    connected: true,
    healthy: booleanValue(health?.ok),
    version: source.version,
    uptimeMs: source.uptimeMs,
    healthTimestamp: numberValue(health?.ts),
    healthDurationMs: numberValue(health?.durationMs),
    provider,
    model: selected.model,
    configuredModel,
    usingFallback: selectedNormalized && configuredNormalized
      ? selectedNormalized !== configuredNormalized
      : null,
    modelAvailable: booleanValue(modelEntry?.available),
    whatsapp: {
      configured: configuredWhatsApp,
      linked,
      running,
      connected,
      healthy: whatsappHealthy,
      healthState,
      lastActivityAt: activityCandidates.length ? Math.max(...activityCandidates) : null,
      lastError,
    },
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}
