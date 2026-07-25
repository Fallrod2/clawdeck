import { describe, expect, test } from "bun:test";
import {
  createAnomalyJournal,
  foldAnomalies,
  readAnomalySignals,
  MAX_ENTRIES,
  REGROUP_WINDOW_MS,
  RETENTION_MS,
  type AnomalyEntry,
  type AnomalyInputs,
  type AnomalySignal,
} from "./anomalies";

const T0 = 1_700_000_000_000;

function inputs(overrides: Partial<AnomalyInputs> = {}): AnomalyInputs {
  return {
    gateway: { ok: true },
    openclaw: {
      connected: true,
      healthy: true,
      provider: "openai",
      model: "gpt-5-codex",
      configuredModel: "openai/gpt-5-codex",
      usingFallback: false,
      modelAvailable: true,
      whatsapp: { healthy: true, healthState: "healthy", lastError: null },
      ...overrides.openclaw,
    },
    ollama: { ok: true, fallbackModelReady: true },
    network: { severity: "good", verdict: "operational", headline: "Liaison réseau complète", silentHosts: [] },
    ...overrides,
  };
}

function keysOf(list: { key: string }[]): string[] {
  return list.map((item) => item.key);
}

function sig(key: string, severity: AnomalySignal["severity"] = "critical"): AnomalySignal {
  return { key, scope: "Test", severity, label: `Anomalie ${key}`, detail: "" };
}

describe("readAnomalySignals", () => {
  test("un instantané sain ne journalise rien", () => {
    expect(readAnomalySignals(inputs())).toEqual([]);
  });

  test("sonde HTTP en échec : anomalie de gateway, avec la cause mesurée", () => {
    const signals = readAnomalySignals(inputs({ gateway: { ok: false, error: "ECONNREFUSED" } }));
    expect(keysOf(signals)).toEqual(["gateway:http"]);
    expect(signals[0]!.severity).toBe("critical");
    expect(signals[0]!.detail).toContain("ECONNREFUSED");
  });

  test("une gateway tombée ne produit qu'UNE anomalie, pas une par champ rouge", () => {
    // Cas réel : quand la gateway s'éteint, sa sonde HTTP, son WebSocket et sa
    // santé RPC s'éteignent ensemble. Trois entrées feraient passer un incident
    // pour trois.
    const signals = readAnomalySignals(
      inputs({
        gateway: { ok: false, error: "fetch failed" },
        openclaw: { ...inputs().openclaw, connected: false, healthy: false },
      }),
    );
    expect(keysOf(signals)).toEqual(["gateway:http"]);
  });

  test("service HTTP debout mais WebSocket de contrôle rompu : constat distinct", () => {
    const signals = readAnomalySignals(
      inputs({ openclaw: { ...inputs().openclaw, connected: false } }),
    );
    expect(keysOf(signals)).toEqual(["gateway:rpc"]);
    expect(signals[0]!.label).toContain("contrôle");
  });

  test("le verdict réseau est repris tel quel, jamais recalculé depuis les sondes", () => {
    const signals = readAnomalySignals(
      inputs({
        network: {
          severity: "critical",
          verdict: "upstream-outage",
          headline: "Coupure en amont de la passerelle locale",
          silentHosts: ["1.1.1.1", "83.204.110.38"],
        },
      }),
    );
    expect(keysOf(signals)).toEqual(["network:upstream-outage"]);
    expect(signals[0]!.label).toBe("Coupure en amont de la passerelle locale");
    expect(signals[0]!.detail).toContain("1.1.1.1");
    expect(signals[0]!.detail).toContain("Muets");
  });

  test("deux verdicts réseau différents sont deux constats, pas deux occurrences", () => {
    const partial = readAnomalySignals(
      inputs({
        network: { severity: "warning", verdict: "external-partial", headline: "Accès externe partiel", silentHosts: ["83.204.110.38"] },
      }),
    );
    const blackout = readAnomalySignals(
      inputs({
        network: { severity: "critical", verdict: "blackout", headline: "Aucune sonde réseau ne répond", silentHosts: [] },
      }),
    );
    expect(partial[0]!.key).not.toBe(blackout[0]!.key);
    expect(partial[0]!.severity).toBe("warning");
  });

  test("bascule sur le repli : dégradation nommée, avec les deux modèles", () => {
    const signals = readAnomalySignals(
      inputs({
        openclaw: {
          ...inputs().openclaw,
          provider: "ollama",
          model: "qwen3.5:9b",
          usingFallback: true,
        },
      }),
    );
    expect(keysOf(signals)).toEqual(["modele:repli"]);
    expect(signals[0]!.severity).toBe("warning");
    expect(signals[0]!.detail).toContain("ollama/qwen3.5:9b");
    expect(signals[0]!.detail).toContain("openai/gpt-5-codex");
  });

  test("modèle actif indisponible prime sur la simple bascule", () => {
    const signals = readAnomalySignals(
      inputs({ openclaw: { ...inputs().openclaw, usingFallback: true, modelAvailable: false } }),
    );
    expect(keysOf(signals)).toEqual(["modele:indisponible"]);
    expect(signals[0]!.severity).toBe("critical");
  });

  test("WhatsApp en échec est journalisé avec l'erreur remontée par OpenClaw", () => {
    const signals = readAnomalySignals(
      inputs({
        openclaw: {
          ...inputs().openclaw,
          whatsapp: { healthy: false, healthState: "unhealthy", lastError: "socket fermé" },
        },
      }),
    );
    expect(keysOf(signals)).toEqual(["whatsapp:sante"]);
    expect(signals[0]!.detail).toContain("socket fermé");
  });

  test("un état INCONNU n'est jamais une anomalie", () => {
    // C'est ce que produit `unavailableOpenClawRuntime` quand la gateway est
    // muette : tout passe à null. Le journal doit retenir la coupure de
    // gateway, pas inventer une panne de canal ni de modèle.
    const signals = readAnomalySignals(
      inputs({
        gateway: { ok: false },
        openclaw: {
          connected: false,
          healthy: false,
          provider: null,
          model: null,
          configuredModel: null,
          usingFallback: null,
          modelAvailable: null,
          whatsapp: { healthy: null, healthState: null, lastError: null },
        },
        ollama: { ok: true, fallbackModelReady: true },
      }),
    );
    expect(keysOf(signals)).toEqual(["gateway:http"]);
  });

  test("Ollama garde la sévérité de sa carte : injoignable critique, modèle absent dégradé", () => {
    expect(readAnomalySignals(inputs({ ollama: { ok: false, error: "connexion refusée" } }))[0]).toMatchObject({
      key: "ollama:injoignable",
      severity: "critical",
    });
    expect(readAnomalySignals(inputs({ ollama: { ok: true, fallbackModelReady: false } }))[0]).toMatchObject({
      key: "ollama:modele",
      severity: "warning",
    });
  });

  test("plusieurs sous-systèmes touchés : un signal chacun, jamais plus", () => {
    const signals = readAnomalySignals(
      inputs({
        gateway: { ok: false },
        ollama: { ok: false },
        network: { severity: "critical", verdict: "blackout", headline: "Aucune sonde réseau ne répond", silentHosts: ["1.1.1.1"] },
      }),
    );
    expect(keysOf(signals)).toEqual(["gateway:http", "network:blackout", "ollama:injoignable"]);
  });

  test("un détail interminable est borné à la source, pas à l'affichage", () => {
    const signals = readAnomalySignals(inputs({ gateway: { ok: false, error: "x".repeat(500) } }));
    expect(signals[0]!.detail.length).toBeLessThanOrEqual(140);
    expect(signals[0]!.detail.endsWith("…")).toBe(true);
  });
});

describe("foldAnomalies", () => {
  test("une anomalie inédite ouvre une entrée en cours", () => {
    const entries = foldAnomalies([], [sig("gateway:http")], T0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ startedAt: T0, lastSeenAt: T0, endedAt: null, occurrences: 1 });
  });

  test("une anomalie qui dure reste UNE entrée, pas une par cycle de sonde", () => {
    let entries = foldAnomalies([], [sig("gateway:http")], T0);
    entries = foldAnomalies(entries, [sig("gateway:http")], T0 + 5_000);
    entries = foldAnomalies(entries, [sig("gateway:http")], T0 + 10_000);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ startedAt: T0, lastSeenAt: T0 + 10_000, occurrences: 1 });
  });

  test("le retour au vert date l'entrée au lieu de l'effacer", () => {
    let entries = foldAnomalies([], [sig("gateway:http")], T0);
    entries = foldAnomalies(entries, [], T0 + 5_000);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.endedAt).toBe(T0 + 5_000);
    expect(entries[0]!.startedAt).toBe(T0);
  });

  test("une sonde qui clignote produit UNE ligne et un compteur, pas dix lignes", () => {
    // Le cas qui rendait la liste inutilisable : échec / succès / échec…
    let entries: AnomalyEntry[] = [];
    let now = T0;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      entries = foldAnomalies(entries, [sig("network:blackout")], now);
      now += 5_000;
      entries = foldAnomalies(entries, [], now);
      now += 5_000;
    }
    expect(entries).toHaveLength(1);
    expect(entries[0]!.occurrences).toBe(10);
    // Le début de l'épisode est conservé : c'est lui qui dit « depuis 03:42 ».
    expect(entries[0]!.startedAt).toBe(T0);
  });

  test("au-delà de la fenêtre de regroupement, c'est un nouvel incident", () => {
    let entries = foldAnomalies([], [sig("network:blackout")], T0);
    entries = foldAnomalies(entries, [], T0 + 1_000);
    const later = T0 + 1_000 + REGROUP_WINDOW_MS + 1;
    entries = foldAnomalies(entries, [sig("network:blackout")], later);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ startedAt: later, endedAt: null, occurrences: 1 });
    expect(entries[1]).toMatchObject({ startedAt: T0, endedAt: T0 + 1_000 });
  });

  test("juste à la limite de la fenêtre, le rebond est encore regroupé", () => {
    let entries = foldAnomalies([], [sig("network:blackout")], T0);
    entries = foldAnomalies(entries, [], T0 + 1_000);
    entries = foldAnomalies(entries, [sig("network:blackout")], T0 + 1_000 + REGROUP_WINDOW_MS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.occurrences).toBe(2);
  });

  test("un rebond rouvre l'entrée : elle redevient « en cours »", () => {
    let entries = foldAnomalies([], [sig("gateway:http")], T0);
    entries = foldAnomalies(entries, [], T0 + 1_000);
    entries = foldAnomalies(entries, [sig("gateway:http")], T0 + 2_000);
    expect(entries[0]!.endedAt).toBeNull();
    expect(entries[0]!.lastSeenAt).toBe(T0 + 2_000);
  });

  test("le libellé et la cause suivent la dernière mesure", () => {
    let entries = foldAnomalies([], [sig("gateway:http")], T0);
    entries = foldAnomalies(
      entries,
      [{ key: "gateway:http", scope: "Gateway", severity: "critical", label: "Autre constat", detail: "cause fraîche" }],
      T0 + 5_000,
    );
    expect(entries[0]).toMatchObject({ label: "Autre constat", detail: "cause fraîche" });
  });

  test("les anomalies résolues sortent du journal passé la rétention", () => {
    let entries = foldAnomalies([], [sig("gateway:http")], T0);
    entries = foldAnomalies(entries, [], T0 + 1_000);
    entries = foldAnomalies(entries, [], T0 + 1_000 + RETENTION_MS + 1);
    expect(entries).toEqual([]);
  });

  test("une anomalie EN COURS depuis longtemps n'est jamais purgée", () => {
    let entries = foldAnomalies([], [sig("gateway:http")], T0);
    entries = foldAnomalies(entries, [sig("gateway:http")], T0 + RETENTION_MS * 3);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.endedAt).toBeNull();
  });

  test("la borne dure tronque les plus anciennes résolues, jamais celles en cours", () => {
    let entries: AnomalyEntry[] = [];
    let now = T0;
    // Beaucoup d'épisodes distincts, espacés au-delà de la fenêtre de
    // regroupement pour qu'ils comptent chacun pour une entrée.
    for (let episode = 0; episode < MAX_ENTRIES + 6; episode += 1) {
      entries = foldAnomalies(entries, [sig(`network:v${episode}`)], now);
      now += 1_000;
      entries = foldAnomalies(entries, [], now);
      now += REGROUP_WINDOW_MS + 1_000;
    }
    entries = foldAnomalies(entries, [sig("gateway:http")], now);
    expect(entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(entries[0]).toMatchObject({ key: "gateway:http", endedAt: null });
  });

  test("les entrées en cours passent devant, puis les plus récemment résolues", () => {
    let entries = foldAnomalies([], [sig("a"), sig("b")], T0);
    entries = foldAnomalies(entries, [sig("b")], T0 + 1_000);
    expect(keysOf(entries)).toEqual(["b", "a"]);
  });

  test("l'ordre reste stable d'un cycle à l'autre quand rien ne change", () => {
    const signals = [sig("a"), sig("b", "warning"), sig("c")];
    let entries = foldAnomalies([], signals, T0);
    const first = keysOf(entries);
    entries = foldAnomalies(entries, signals, T0 + 5_000);
    expect(keysOf(entries)).toEqual(first);
  });

  test("l'état précédent n'est jamais modifié", () => {
    const previous = foldAnomalies([], [sig("gateway:http")], T0);
    const snapshot = structuredClone(previous);
    foldAnomalies(previous, [], T0 + 5_000);
    expect(previous).toEqual(snapshot);
  });
});

describe("createAnomalyJournal", () => {
  test("le journal annonce sa fenêtre d'observation et repart vide", () => {
    const journal = createAnomalyJournal(T0);
    const payload = journal.observe(inputs(), T0 + 1_000);
    expect(payload.since).toBe(T0);
    expect(payload.retentionMs).toBe(RETENTION_MS);
    expect(payload.entries).toEqual([]);
    // Un second journal ne sait rien du premier : c'est exactement ce qui se
    // passe au redémarrage du backend, et l'interface doit pouvoir le dire.
    expect(createAnomalyJournal(T0 + 10_000).observe(inputs(), T0 + 10_000).since).toBe(T0 + 10_000);
  });

  test("une panne puis un retour au vert laissent une trace consultable", () => {
    const journal = createAnomalyJournal(T0);
    journal.observe(inputs(), T0);
    journal.observe(inputs({ gateway: { ok: false, error: "fetch failed" } }), T0 + 5_000);
    const payload = journal.observe(inputs(), T0 + 10_000);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      key: "gateway:http",
      startedAt: T0 + 5_000,
      endedAt: T0 + 10_000,
    });
  });
});
