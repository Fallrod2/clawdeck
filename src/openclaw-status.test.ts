import { describe, expect, test } from "bun:test";
import {
  readOpenClawRuntime,
  unavailableOpenClawRuntime,
  type OpenClawStatusSource,
} from "./openclaw-status";
import { createOpenClawUsageReader } from "./openclaw-usage";

// Lecteur neuf par appel : l'étranglement du lecteur par défaut ferait fuir
// l'usage lu par un test dans le suivant.
function usageReader() {
  return createOpenClawUsageReader({ minIntervalMs: 0 });
}

function source(overrides: Partial<OpenClawStatusSource> = {}): OpenClawStatusSource {
  return {
    isConnected: true,
    version: "2026.6.11",
    uptimeMs: 123_000,
    mainSessionKey: "agent:main:main",
    getHealthSnapshot: async () => ({ ok: true, ts: 1_000, durationMs: 32 }),
    // Ligne sessions.list de la session principale (forme réelle observée
    // sur la gateway installée : modelProvider + model + agentRuntime).
    getMainSessionEntry: async () => ({
      key: "agent:main:main",
      modelProvider: "ollama",
      model: "qwen3.5:9b",
      agentRuntime: { id: "codex", source: "implicit" },
    }),
    // agents.list : modèle configuré (primary) et fallbacks de l'agent.
    getAgentsSummary: async () => ({
      agents: [{
        id: "main",
        model: { primary: "openai/gpt-5.4", fallbacks: ["ollama/qwen3.5:9b"] },
      }],
    }),
    getWhatsAppStatus: async () => ({
      channels: {
        whatsapp: {
          configured: true,
          linked: true,
          running: true,
          connected: true,
          healthState: "healthy",
          lastInboundAt: 900,
          self: { e164: "+33000000000" },
        },
      },
      channelAccounts: {
        whatsapp: [{
          accountId: "default",
          configured: true,
          linked: true,
          running: true,
          connected: true,
          healthState: "healthy",
          lastOutboundAt: 950,
        }],
      },
    }),
    getConfiguredModels: async () => ({
      models: [{ id: "qwen3.5:9b", provider: "ollama", available: true }],
    }),
    // usage.status / usage.cost : forme réelle des handlers d'usage de la
    // gateway (détaillée dans openclaw-usage.test.ts).
    getUsageStatus: async () => ({
      updatedAt: 1_000,
      providers: [{
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "5h", usedPercent: 20 }],
      }],
    }),
    getUsageCost: async () => ({
      updatedAt: 1_000,
      days: 30,
      totals: { totalTokens: 100, totalCost: 0.5 },
      cacheStatus: { status: "fresh", cachedFiles: 3, pendingFiles: 0, staleFiles: 0 },
    }),
    ...overrides,
  };
}

describe("readOpenClawRuntime", () => {
  test("normalizes active fallback and WhatsApp without leaking account identity", async () => {
    const result = await readOpenClawRuntime(source(), usageReader());

    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3.5:9b");
    expect(result.configuredModel).toBe("openai/gpt-5.4");
    expect(result.usingFallback).toBe(true);
    expect(result.modelAvailable).toBe(true);
    expect(result.whatsapp).toEqual({
      configured: true,
      linked: true,
      running: true,
      connected: true,
      healthy: true,
      healthState: "healthy",
      lastActivityAt: 950,
      lastError: null,
    });
    expect(JSON.stringify(result)).not.toContain("+33000000000");
  });

  test("returns an explicit unavailable state without issuing RPCs", async () => {
    let called = false;
    const result = await readOpenClawRuntime(source({
      isConnected: false,
      getHealthSnapshot: async () => {
        called = true;
        return {};
      },
    }), usageReader());

    expect(called).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.healthy).toBe(false);
    expect(result.whatsapp.healthy).toBeNull();
  });

  test("un lastError ancien ne dégrade pas un canal WhatsApp rétabli", async () => {
    const result = await readOpenClawRuntime(source({
      getWhatsAppStatus: async () => ({
        channels: {
          whatsapp: {
            configured: true,
            linked: true,
            running: true,
            connected: true,
            healthState: "healthy",
            lastError: "stream errored (515)",
          },
        },
      }),
    }), usageReader());

    expect(result.whatsapp.healthy).toBe(true);
    expect(result.whatsapp.lastError).toBe("stream errored (515)");
  });

  test("laisse le modèle configuré à null quand agents.list échoue", async () => {
    const result = await readOpenClawRuntime(source({
      getAgentsSummary: async () => {
        throw new Error("agents unavailable");
      },
    }), usageReader());

    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3.5:9b");
    expect(result.configuredModel).toBeNull();
    expect(result.usingFallback).toBeNull();
    expect(result.error).toBe("agents unavailable");
  });

  test("keeps partial data when one RPC fails", async () => {
    const result = await readOpenClawRuntime(source({
      getConfiguredModels: async () => {
        throw new Error("models unavailable");
      },
    }), usageReader());

    expect(result.model).toBe("qwen3.5:9b");
    expect(result.error).toBe("models unavailable");
  });

  test("joint l'usage au statut sans le confondre avec la santé de la gateway", async () => {
    const result = await readOpenClawRuntime(source(), usageReader());

    expect(result.usage?.quota.state).toBe("ready");
    expect(result.usage?.quota.providers[0]?.worstUsedPercent).toBe(20);
    expect(result.usage?.cost.state).toBe("ready");
    // L'usage porte ses pannes dans ses propres états : il ne contribue
    // jamais à `error`, qui reste le résumé des RPC de santé.
    expect(result.error).toBeUndefined();
  });

  test("un usage en échec n'alourdit pas l'erreur de statut", async () => {
    const result = await readOpenClawRuntime(
      source({
        getUsageStatus: async () => {
          throw new Error("usage unreachable");
        },
      }),
      usageReader(),
    );

    expect(result.healthy).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.usage?.quota.state).toBe("error");
  });

  test("gateway sans méthode d'usage : « non supporté », pas une carte vide", async () => {
    const result = await readOpenClawRuntime(
      source({
        getUsageStatus: async () => null,
        getUsageCost: async () => null,
      }),
      usageReader(),
    );

    expect(result.usage?.quota.state).toBe("unsupported");
    expect(result.usage?.cost.state).toBe("unsupported");
  });

  test("hors connexion, l'usage est « pas encore mesuré » et non « non supporté »", () => {
    const result = unavailableOpenClawRuntime({ version: null, uptimeMs: null });

    expect(result.usage?.quota.state).toBe("pending");
    expect(result.usage?.cost.state).toBe("pending");
  });
});
