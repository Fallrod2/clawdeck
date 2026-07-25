import { describe, expect, test } from "bun:test";
import { buildTimeline, formatDayLabel, GROUP_WINDOW_MS, type MessageGroup } from "./timeline";
import type { ChatMessage } from "./chatTypes";

const DAY = 24 * 60 * 60_000;
// 2026-07-25T12:00:00 heure locale — ancrage fixe pour ne pas dépendre du
// fuseau de la machine de test.
const NOON = new Date(2026, 6, 25, 12, 0, 0).getTime();

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "user",
    text: "bonjour",
    timestamp: NOON,
    pending: false,
    toolCalls: [],
    ...overrides,
  };
}

function groups(items: ReturnType<typeof buildTimeline>): MessageGroup[] {
  return items.filter((i): i is MessageGroup => i.kind === "group");
}

describe("buildTimeline", () => {
  test("transcript vide : aucun élément", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  test("un marqueur de jour ouvre le fil", () => {
    const items = buildTimeline([msg({ id: "a" })]);
    expect(items[0]?.kind).toBe("day");
    expect(items).toHaveLength(2);
  });

  test("messages rapprochés du même auteur : un seul groupe", () => {
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON }),
      msg({ id: "b", timestamp: NOON + 30_000 }),
      msg({ id: "c", timestamp: NOON + 60_000 }),
    ]);
    expect(groups(items)).toHaveLength(1);
    expect(groups(items)[0]?.messages).toHaveLength(3);
  });

  test("le groupe porte l'heure de son PREMIER message", () => {
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON }),
      msg({ id: "b", timestamp: NOON + 60_000 }),
    ]);
    expect(groups(items)[0]?.timestamp).toBe(NOON);
  });

  test("changement d'auteur : nouveau groupe même à la même seconde", () => {
    const items = buildTimeline([
      msg({ id: "a", role: "user", timestamp: NOON }),
      msg({ id: "b", role: "assistant", timestamp: NOON }),
    ]);
    expect(groups(items)).toHaveLength(2);
  });

  test("silence au-delà de la fenêtre : nouveau groupe", () => {
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON }),
      msg({ id: "b", timestamp: NOON + GROUP_WINDOW_MS + 1 }),
    ]);
    expect(groups(items)).toHaveLength(2);
  });

  test("pile sur la fenêtre : encore le même groupe", () => {
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON }),
      msg({ id: "b", timestamp: NOON + GROUP_WINDOW_MS }),
    ]);
    expect(groups(items)).toHaveLength(1);
  });

  test("provenances différentes : groupes séparés", () => {
    // Sinon l'étiquette « via WhatsApp » du groupe mentirait sur le message
    // écrit depuis le dashboard qui s'y serait fondu.
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON }),
      msg({ id: "b", timestamp: NOON + 1_000, origin: { channel: "whatsapp" } }),
    ]);
    expect(groups(items)).toHaveLength(2);
    expect(groups(items)[1]?.origin?.channel).toBe("whatsapp");
  });

  test("changement de jour : marqueur inséré et groupe rouvert", () => {
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON - DAY }),
      msg({ id: "b", timestamp: NOON }),
    ]);
    expect(items.filter((i) => i.kind === "day")).toHaveLength(2);
    expect(groups(items)).toHaveLength(2);
  });

  test("deux messages proches mais à cheval sur minuit : jamais groupés", () => {
    const beforeMidnight = new Date(2026, 6, 25, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 6, 26, 0, 0, 10).getTime();
    const items = buildTimeline([
      msg({ id: "a", timestamp: beforeMidnight }),
      msg({ id: "b", timestamp: afterMidnight }),
    ]);
    expect(groups(items)).toHaveLength(2);
    expect(items.filter((i) => i.kind === "day")).toHaveLength(2);
  });

  test("l'ordre reçu est conservé, rien n'est trié ni dédupliqué", () => {
    const items = buildTimeline([
      msg({ id: "a", timestamp: NOON + 60_000 }),
      msg({ id: "b", timestamp: NOON }),
    ]);
    expect(groups(items)[0]?.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("formatDayLabel", () => {
  test("aujourd'hui et hier sont nommés, pas datés", () => {
    expect(formatDayLabel(NOON, NOON)).toBe("Aujourd'hui");
    expect(formatDayLabel(NOON - DAY, NOON)).toBe("Hier");
  });

  test("début de journée compte encore comme aujourd'hui", () => {
    const earlyToday = new Date(2026, 6, 25, 0, 5, 0).getTime();
    expect(formatDayLabel(earlyToday, NOON)).toBe("Aujourd'hui");
  });

  test("date complète au-delà, sans l'année si elle est courante", () => {
    const label = formatDayLabel(NOON - 5 * DAY, NOON);
    expect(label).toContain("juillet");
    expect(label).not.toContain("2026");
  });

  test("année affichée pour une date d'une autre année", () => {
    const lastYear = new Date(2025, 11, 24, 10, 0, 0).getTime();
    expect(formatDayLabel(lastYear, NOON)).toContain("2025");
  });
});

describe("buildTimeline — attribution de modèle", () => {
  test("le groupe porte le modèle de ses messages", () => {
    const items = buildTimeline([
      msg({ id: "a", role: "assistant", model: { provider: "openai", name: "gpt-5.6-luna" } }),
    ]);
    expect(groups(items)[0]?.model?.name).toBe("gpt-5.6-luna");
  });

  test("changement de modèle en cours d'échange : groupes séparés", () => {
    // Le cas qui compte : le repli local prend la main. Une étiquette unique
    // attribuerait à un modèle des réponses produites par l'autre.
    const items = buildTimeline([
      msg({ id: "a", role: "assistant", timestamp: NOON, model: { provider: "openai", name: "gpt-5.6-luna" } }),
      msg({ id: "b", role: "assistant", timestamp: NOON + 1_000, model: { provider: "ollama", name: "qwen3.5:9b" } }),
    ]);
    expect(groups(items)).toHaveLength(2);
    expect(groups(items)[1]?.model?.provider).toBe("ollama");
  });

  test("modèle absent puis présent : groupes séparés aussi", () => {
    const items = buildTimeline([
      msg({ id: "a", role: "assistant", timestamp: NOON }),
      msg({ id: "b", role: "assistant", timestamp: NOON + 1_000, model: { provider: "openai", name: "x" } }),
    ]);
    expect(groups(items)).toHaveLength(2);
  });
});
