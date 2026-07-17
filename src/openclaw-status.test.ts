import { describe, expect, test } from "bun:test";
import { readOpenClawRuntime, type OpenClawStatusSource } from "./openclaw-status";

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
    ...overrides,
  };
}

describe("readOpenClawRuntime", () => {
  test("normalizes active fallback and WhatsApp without leaking account identity", async () => {
    const result = await readOpenClawRuntime(source());

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
    }));

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
    }));

    expect(result.whatsapp.healthy).toBe(true);
    expect(result.whatsapp.lastError).toBe("stream errored (515)");
  });

  test("laisse le modèle configuré à null quand agents.list échoue", async () => {
    const result = await readOpenClawRuntime(source({
      getAgentsSummary: async () => {
        throw new Error("agents unavailable");
      },
    }));

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
    }));

    expect(result.model).toBe("qwen3.5:9b");
    expect(result.error).toBe("models unavailable");
  });
});
