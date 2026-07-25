import { describe, expect, test } from "bun:test";
import { activityLabel, formatElapsed, RUN_STALE_AFTER_MS, selectLiveRuns } from "./activity";
import type { RunActivity } from "./chatTypes";

function run(overrides: Partial<RunActivity> = {}): RunActivity {
  return {
    runId: "r1",
    own: false,
    startedAt: 0,
    lastEventAt: 0,
    tool: null,
    waitingApproval: false,
    ...overrides,
  };
}

describe("selectLiveRuns", () => {
  test("écarte un run muet depuis plus que le seuil de péremption", () => {
    const now = 1_000_000;
    const runs = [
      run({ runId: "frais", lastEventAt: now - 5_000 }),
      run({ runId: "perdu", lastEventAt: now - RUN_STALE_AFTER_MS - 1 }),
    ];
    expect(selectLiveRuns(runs, now).map((r) => r.runId)).toEqual(["frais"]);
  });

  test("garde un run pile sous le seuil (borne exclusive au-delà seulement)", () => {
    const now = 1_000_000;
    const runs = [run({ runId: "limite", lastEventAt: now - RUN_STALE_AFTER_MS + 1 })];
    expect(selectLiveRuns(runs, now)).toHaveLength(1);
  });

  test("trie du plus récemment actif au plus ancien", () => {
    const now = 1_000_000;
    const runs = [
      run({ runId: "vieux", lastEventAt: now - 30_000 }),
      run({ runId: "recent", lastEventAt: now - 1_000 }),
      run({ runId: "moyen", lastEventAt: now - 10_000 }),
    ];
    expect(selectLiveRuns(runs, now).map((r) => r.runId)).toEqual(["recent", "moyen", "vieux"]);
  });

  test("ne mute pas le tableau reçu", () => {
    const now = 1_000_000;
    const runs = [run({ runId: "a", lastEventAt: now - 30_000 }), run({ runId: "b", lastEventAt: now - 1_000 })];
    selectLiveRuns(runs, now);
    expect(runs.map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

describe("activityLabel", () => {
  test("l'attente d'autorisation prime sur l'outil courant", () => {
    // Un run bloqué peut porter un dernier outil connu : c'est l'état
    // bloquant qu'il faut annoncer, pas l'outil qu'il exécutait.
    const label = activityLabel(run({ waitingApproval: true, tool: { name: "exec", phase: "start" } }));
    expect(label).toBe("attend une autorisation");
  });

  test("sans outil connu : réflexion en cours", () => {
    expect(activityLabel(run())).toBe("réfléchit");
  });

  test("nom d'outil conservé tel quel, préfixé d'un verbe", () => {
    expect(activityLabel(run({ tool: { name: "exec", phase: "start" } }))).toBe("exécute exec");
    expect(activityLabel(run({ tool: { name: "read_file", phase: "update" } }))).toBe("exécute read_file");
    expect(activityLabel(run({ tool: { name: "exec", phase: "result" } }))).toBe("a terminé exec");
  });
});

describe("formatElapsed", () => {
  test("paliers seconde / minute / heure", () => {
    expect(formatElapsed(0)).toBe("0 s");
    expect(formatElapsed(59_999)).toBe("59 s");
    expect(formatElapsed(60_000)).toBe("1 min");
    expect(formatElapsed(59 * 60_000)).toBe("59 min");
    expect(formatElapsed(60 * 60_000)).toBe("1 h");
  });

  test("une durée négative (horloge décalée) ne produit pas de valeur absurde", () => {
    expect(formatElapsed(-5_000)).toBe("0 s");
  });
});
