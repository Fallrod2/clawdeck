// src/openclaw-usage.test.ts — normalisation de l'usage OpenClaw.
//
// Les charges utilisées ici reproduisent la forme réellement produite par la
// gateway installée (paquet openclaw, handlers `usage.status` / `usage.cost`) :
// providers/windows/billing pour les quotas, totals/cacheStatus pour le coût.

import { describe, expect, test } from "bun:test";
import {
  createOpenClawUsageReader,
  normalizeCostUsage,
  normalizeQuotaUsage,
  pendingOpenClawUsage,
  type OpenClawUsageSource,
} from "./openclaw-usage";

// Réponse `usage.status` telle que la construit loadProviderUsageSummary :
// un instantané par fournisseur authentifié, fenêtres bornées à 0-100.
const QUOTA_PAYLOAD = {
  updatedAt: 1_700_000_000_000,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      plan: "pro",
      windows: [
        { label: "5h", usedPercent: 12.5, resetAt: 1_700_000_600_000 },
        { label: "Week", usedPercent: 64, resetAt: 1_700_400_000_000 },
      ],
      billing: [{ type: "balance", amount: 42, unit: "credits" }],
    },
    {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "HTTP 401",
    },
  ],
};

// Réponse `usage.cost` : totaux plats + état du cache de calcul d'OpenClaw.
const COST_PAYLOAD = {
  updatedAt: 1_700_000_000_000,
  days: 30,
  daily: [],
  totals: {
    input: 1_000,
    output: 250,
    cacheRead: 4_000,
    cacheWrite: 500,
    totalTokens: 5_750,
    totalCost: 1.2345,
    inputCost: 0.5,
    outputCost: 0.7,
    cacheReadCost: 0.03,
    cacheWriteCost: 0.0045,
    missingCostEntries: 3,
  },
  cacheStatus: {
    status: "partial",
    cachedFiles: 12,
    pendingFiles: 2,
    staleFiles: 2,
    refreshedAt: 1_699_999_000_000,
  },
};

function source(overrides: Partial<OpenClawUsageSource> = {}): OpenClawUsageSource {
  return {
    getUsageStatus: async () => QUOTA_PAYLOAD,
    getUsageCost: async () => COST_PAYLOAD,
    ...overrides,
  };
}

describe("normalizeQuotaUsage", () => {
  test("aplatit fenêtres et soldes, et retient la fenêtre la plus contrainte", () => {
    const quota = normalizeQuotaUsage(QUOTA_PAYLOAD);

    expect(quota.state).toBe("ready");
    expect(quota.measuredAt).toBe(1_700_000_000_000);
    expect(quota.providers).toHaveLength(2);

    const openai = quota.providers[0]!;
    expect(openai.id).toBe("openai");
    expect(openai.displayName).toBe("OpenAI");
    expect(openai.plan).toBe("pro");
    expect(openai.windows).toEqual([
      { label: "5h", usedPercent: 12.5, resetAt: 1_700_000_600_000 },
      { label: "Week", usedPercent: 64, resetAt: 1_700_400_000_000 },
    ]);
    expect(openai.worstUsedPercent).toBe(64);
    expect(openai.balances).toEqual([{
      kind: "balance",
      label: null,
      amount: 42,
      used: null,
      limit: null,
      unit: "credits",
      period: null,
      resetAt: null,
    }]);
    expect(openai.error).toBeNull();
  });

  test("garde un fournisseur qui ne remonte qu'une erreur, sans dégrader l'état d'ensemble", () => {
    const quota = normalizeQuotaUsage(QUOTA_PAYLOAD);
    const anthropic = quota.providers[1]!;

    expect(quota.state).toBe("ready");
    expect(anthropic.error).toBe("HTTP 401");
    expect(anthropic.windows).toEqual([]);
    expect(anthropic.worstUsedPercent).toBeNull();
    // displayName absent : on retombe sur l'identifiant plutôt qu'une case vide.
    expect(normalizeQuotaUsage({ providers: [{ provider: "zai" }] }).providers[0]!.displayName)
      .toBe("zai");
  });

  test("aucun fournisseur configuré donne « vide », pas une panne", () => {
    const quota = normalizeQuotaUsage({ updatedAt: 5, providers: [] });

    expect(quota.state).toBe("empty");
    expect(quota.providers).toEqual([]);
    expect(quota.error).toBeNull();
  });

  test("écarte les fenêtres et soldes inexploitables, et borne les pourcentages", () => {
    const quota = normalizeQuotaUsage({
      providers: [{
        provider: "openai",
        windows: [
          { label: "5h", usedPercent: 140 },
          { label: "Week" },
          { usedPercent: 10 },
          "cassé",
        ],
        billing: [
          { type: "budget", used: 1, unit: "USD" },
          { type: "inconnu", amount: 3, unit: "USD" },
          { type: "budget", used: 4, limit: 20, unit: "USD", period: "month" },
        ],
      }],
    });
    const provider = quota.providers[0]!;

    expect(provider.windows).toEqual([{ label: "5h", usedPercent: 100, resetAt: null }]);
    expect(provider.balances).toHaveLength(1);
    expect(provider.balances[0]).toMatchObject({ kind: "budget", used: 4, limit: 20, period: "month" });
  });

  test("reste totale face à une charge inattendue", () => {
    expect(normalizeQuotaUsage(null).state).toBe("empty");
    expect(normalizeQuotaUsage("nope").state).toBe("empty");
    expect(normalizeQuotaUsage({ providers: "nope" }).providers).toEqual([]);
  });
});

describe("normalizeCostUsage", () => {
  test("expose les agrégats et la fraîcheur déclarée par OpenClaw", () => {
    const cost = normalizeCostUsage(COST_PAYLOAD, 30);

    expect(cost).toEqual({
      state: "ready",
      windowDays: 30,
      totalCost: 1.2345,
      totalTokens: 5_750,
      inputTokens: 1_000,
      outputTokens: 250,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 500,
      missingCostEntries: 3,
      freshness: "partial",
      measuredAt: 1_700_000_000_000,
      error: null,
    });
  });

  test("un cache encore vide et en travail vaut « pas encore mesuré », pas « zéro »", () => {
    const cost = normalizeCostUsage({
      updatedAt: 9,
      days: 30,
      totals: { totalTokens: 0, totalCost: 0 },
      cacheStatus: { status: "refreshing", cachedFiles: 0, pendingFiles: 40, staleFiles: 40 },
    }, 30);

    expect(cost.state).toBe("pending");
    expect(cost.freshness).toBe("refreshing");
    expect(cost.totalTokens).toBe(0);
  });

  test("un cache à jour sans activité vaut « vide », lui", () => {
    const cost = normalizeCostUsage({
      updatedAt: 9,
      days: 7,
      totals: { totalTokens: 0, totalCost: 0 },
      cacheStatus: { status: "fresh", cachedFiles: 0, pendingFiles: 0, staleFiles: 0 },
    }, 30);

    expect(cost.state).toBe("empty");
    // La fenêtre annoncée par OpenClaw prime sur celle qu'on avait demandée.
    expect(cost.windowDays).toBe(7);
  });

  test("reste totale face à une charge inattendue", () => {
    const cost = normalizeCostUsage(null, 30);

    expect(cost.state).toBe("empty");
    expect(cost.windowDays).toBe(30);
    expect(cost.freshness).toBeNull();
    expect(normalizeCostUsage({ cacheStatus: { status: "bizarre" } }, 30).freshness).toBeNull();
  });
});

describe("createOpenClawUsageReader", () => {
  test("lit les deux blocs et n'expose ni secret ni identifiant de compte", async () => {
    const reader = createOpenClawUsageReader({ minIntervalMs: 0 });
    const usage = await reader.read(source({
      // Champs volontairement sensibles ajoutés à la charge : ils ne doivent
      // ressortir nulle part dans la forme normalisée.
      getUsageStatus: async () => ({
        ...QUOTA_PAYLOAD,
        accountId: "acct_secret_42",
        providers: [{
          ...QUOTA_PAYLOAD.providers[0],
          token: "sk-live-secret",
          accountId: "acct_secret_42",
        }],
      }),
    }));

    expect(usage.quota.state).toBe("ready");
    expect(usage.cost.state).toBe("ready");
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain("acct_secret_42");
    expect(serialized).not.toContain("sk-live-secret");
  });

  test("distingue une gateway qui ne connaît pas la méthode d'un appel en échec", async () => {
    const reader = createOpenClawUsageReader({ minIntervalMs: 0 });
    const usage = await reader.read(source({
      getUsageStatus: async () => null,
      getUsageCost: async () => {
        throw new Error("gateway request timed out: usage.cost");
      },
    }));

    expect(usage.quota.state).toBe("unsupported");
    expect(usage.quota.error).toBeNull();
    expect(usage.cost.state).toBe("error");
    expect(usage.cost.error).toBe("gateway request timed out: usage.cost");
  });

  test("un bloc en panne ne fait pas tomber l'autre", async () => {
    const reader = createOpenClawUsageReader({ minIntervalMs: 0 });
    const usage = await reader.read(source({
      getUsageStatus: async () => {
        throw new Error("provider unreachable");
      },
    }));

    expect(usage.quota.state).toBe("error");
    expect(usage.cost.state).toBe("ready");
  });

  test("étrangle les lectures : les fournisseurs ne sont pas re-sondés à chaque cycle", async () => {
    let calls = 0;
    let clock = 0;
    const reader = createOpenClawUsageReader({ minIntervalMs: 60_000, now: () => clock });
    const probe = source({
      getUsageStatus: async () => {
        calls += 1;
        return QUOTA_PAYLOAD;
      },
    });

    const first = await reader.read(probe);
    clock = 59_999;
    const second = await reader.read(probe);
    expect(calls).toBe(1);
    // Valeur resservie à l'identique : son horodatage reste celui d'OpenClaw,
    // elle ne se rajeunit pas au passage.
    expect(second).toBe(first);
    expect(second.quota.measuredAt).toBe(1_700_000_000_000);

    clock = 60_000;
    await reader.read(probe);
    expect(calls).toBe(2);
  });

  test("mémorise aussi les échecs, pour ne pas marteler un fournisseur en panne", async () => {
    let calls = 0;
    let clock = 0;
    const reader = createOpenClawUsageReader({ minIntervalMs: 60_000, now: () => clock });
    const probe = source({
      getUsageStatus: async () => {
        calls += 1;
        throw new Error("provider unreachable");
      },
    });

    expect((await reader.read(probe)).quota.state).toBe("error");
    clock = 30_000;
    expect((await reader.read(probe)).quota.state).toBe("error");
    expect(calls).toBe(1);
  });

  test("partage une lecture en vol au lieu de la doubler", async () => {
    let calls = 0;
    const reader = createOpenClawUsageReader({ minIntervalMs: 0 });
    const probe = source({
      getUsageStatus: async () => {
        calls += 1;
        await Bun.sleep(5);
        return QUOTA_PAYLOAD;
      },
    });

    const [a, b] = await Promise.all([reader.read(probe), reader.read(probe)]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  test("transmet la fenêtre de coût configurée à la gateway", async () => {
    let requestedDays: number | undefined;
    const reader = createOpenClawUsageReader({ minIntervalMs: 0, costWindowDays: 7 });
    await reader.read(source({
      getUsageCost: async (days) => {
        requestedDays = days;
        return { ...COST_PAYLOAD, days: 7 };
      },
    }));

    expect(requestedDays).toBe(7);
  });
});

describe("pendingOpenClawUsage", () => {
  test("annonce explicitement qu'aucune mesure n'a été tentée", () => {
    const usage = pendingOpenClawUsage();

    expect(usage.quota.state).toBe("pending");
    expect(usage.cost.state).toBe("pending");
    expect(usage.quota.providers).toEqual([]);
    expect(usage.cost.measuredAt).toBeNull();
  });
});
