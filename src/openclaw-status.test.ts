import { describe, expect, test } from "bun:test";
import { readOpenClawRuntime, type OpenClawStatusSource } from "./openclaw-status";

function source(overrides: Partial<OpenClawStatusSource> = {}): OpenClawStatusSource {
  return {
    isConnected: true,
    version: "2026.6.11",
    uptimeMs: 123_000,
    mainSessionKey: "agent:main:main",
    getHealthSnapshot: async () => ({ ok: true, ts: 1_000, durationMs: 32 }),
    getStatusSummary: async () => ({
      sessions: {
        recent: [{
          key: "agent:main:main",
          model: "qwen3.5:9b",
          selectedModel: "ollama/qwen3.5:9b",
          configuredModel: "openai/gpt-5.4",
        }],
      },
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
