// src/db.test.ts — historique des pings : ce que l'insertion stocke vraiment,
// l'agrégation SQL qui borne le graphe à ~360 points, et la rétention 7 jours.
// Base en mémoire et horloge injectée : la base de production est un fichier
// unique partagé avec le backend en cours d'exécution, jamais ouvert ici.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// db.ts importe src/env.ts, qui valide process.env dès son évaluation : sans
// .env — le cas de la CI — le simple import du module échouerait. On complète
// donc ce qui manque avant de le charger, d'où l'import dynamique : un import
// statique serait hissé au-dessus de ces lignes. Aucun test ci-dessous ne
// dépend de ces valeurs, ils travaillent tous sur une base en mémoire.
process.env.AUTH_TOKEN ??= "0123456789abcdef0123456789abcdef";
process.env.GATEWAY_URL ??= "http://127.0.0.1:59999";
process.env.GATEWAY_AUTH_TOKEN ??= "gateway-token-de-test";

const { createPingStore } = await import("./db");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Origine alignée sur une frontière de jour : tous les buckets utilisés ici
// divisent 24 h, donc les bornes calculées par SQL tombent sur des valeurs
// prévisibles plutôt que sur un décalage dépendant de la date du jour.
const T0 = Date.UTC(2026, 6, 1);

interface RawRow {
  target: string;
  host: string;
  ts: number;
  ok: number;
  latencyMs: number | null;
}

// Base neuve par test avec horloge pilotée : `at()` déplace le temps avant
// l'insertion suivante, ce qui permet d'écrire un historique de plusieurs
// jours sans attendre.
function createStore(startMs = T0) {
  const database = new Database(":memory:");
  let clock = startMs;
  const store = createPingStore(database, () => clock);
  return {
    store,
    at(ms: number) {
      clock = ms;
      return store;
    },
    rawRows(): RawRow[] {
      return database
        .query(
          "SELECT target, host, ts, ok, latency_ms as latencyMs FROM pings ORDER BY ts ASC",
        )
        .all() as RawRow[];
    },
    count(): number {
      return (
        database.query("SELECT COUNT(*) as n FROM pings").get() as { n: number }
      ).n;
    },
  };
}

describe("insertPing", () => {
  test("stocke la cible, l'hôte, l'horodatage, le succès en entier et la latence", () => {
    const db = createStore();
    db.at(T0).insertPing("cloudflare", "1.1.1.1", true, 12.5);
    db.at(T0 + MINUTE).insertPing("orange", "192.168.1.1", false, null);

    expect(db.rawRows()).toEqual([
      { target: "cloudflare", host: "1.1.1.1", ts: T0, ok: 1, latencyMs: 12.5 },
      {
        target: "orange",
        host: "192.168.1.1",
        ts: T0 + MINUTE,
        ok: 0,
        latencyMs: null,
      },
    ]);
  });

  test("une sonde en échec garde sa latence absente plutôt qu'un zéro", () => {
    const db = createStore();
    db.store.insertPing("remote", "83.204.110.38", false, null);

    // Un 0 ferait mentir la moyenne du graphe : « injoignable » n'est pas
    // « répond en 0 ms ».
    expect(db.rawRows()[0]!.latencyMs).toBeNull();
  });
});

describe("getPingHistoryBucketed — agrégation", () => {
  test("regroupe un même bucket et aligne l'horodatage sur sa borne basse", () => {
    const db = createStore();
    for (const [offset, latency] of [
      [0, 10],
      [MINUTE, 20],
      [4 * MINUTE, 30],
    ] as const) {
      db.at(T0 + offset).insertPing("cloudflare", "1.1.1.1", true, latency);
    }

    const rows = db.store.getPingHistoryBucketed("cloudflare", T0, 5 * MINUTE);
    expect(rows).toEqual([{ ts: T0, ok: 1, latencyMs: 20 }]);
  });

  test("un seul échec dégrade tout le bucket (MIN(ok))", () => {
    const db = createStore();
    db.at(T0).insertPing("cloudflare", "1.1.1.1", true, 10);
    db.at(T0 + MINUTE).insertPing("cloudflare", "1.1.1.1", false, null);
    db.at(T0 + 2 * MINUTE).insertPing("cloudflare", "1.1.1.1", true, 12);

    // Le graphe front colore un point en incident dès qu'une sonde a échoué :
    // agréger avec MAX ou AVG masquerait la coupure.
    const rows = db.store.getPingHistoryBucketed("cloudflare", T0, 5 * MINUTE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(0);
  });

  test("la moyenne ignore les latences absentes, un bucket sans mesure reste null", () => {
    const db = createStore();
    db.at(T0).insertPing("cloudflare", "1.1.1.1", false, null);
    db.at(T0 + MINUTE).insertPing("cloudflare", "1.1.1.1", true, 20);
    // Bucket suivant : que des échecs, donc aucune latence à moyenner.
    db.at(T0 + 5 * MINUTE).insertPing("cloudflare", "1.1.1.1", false, null);
    db.at(T0 + 6 * MINUTE).insertPing("cloudflare", "1.1.1.1", false, null);

    const rows = db.store.getPingHistoryBucketed("cloudflare", T0, 5 * MINUTE);
    // 20 et non 10 : AVG n'inclut pas les NULL, le front reçoit la latence des
    // seules sondes qui ont répondu.
    expect(rows).toEqual([
      { ts: T0, ok: 0, latencyMs: 20 },
      { ts: T0 + 5 * MINUTE, ok: 0, latencyMs: null },
    ]);
  });

  test("n'agrège jamais deux cibles ensemble", () => {
    const db = createStore();
    db.at(T0).insertPing("cloudflare", "1.1.1.1", true, 10);
    db.at(T0).insertPing("orange", "192.168.1.1", true, 100);
    db.at(T0).insertPing("remote", "83.204.110.38", false, null);

    expect(db.store.getPingHistoryBucketed("cloudflare", T0, 5 * MINUTE)).toEqual([
      { ts: T0, ok: 1, latencyMs: 10 },
    ]);
    expect(db.store.getPingHistoryBucketed("orange", T0, 5 * MINUTE)).toEqual([
      { ts: T0, ok: 1, latencyMs: 100 },
    ]);
  });

  test("la borne sinceMs est inclusive et exclut la mesure d'avant", () => {
    const db = createStore();
    db.at(T0 - 1).insertPing("cloudflare", "1.1.1.1", true, 999);
    db.at(T0).insertPing("cloudflare", "1.1.1.1", true, 10);

    const rows = db.store.getPingHistoryBucketed("cloudflare", T0, MINUTE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latencyMs).toBe(10);
  });

  test("base vide ou fenêtre sans donnée : tableau vide, jamais d'erreur", () => {
    const db = createStore();
    expect(db.store.getPingHistoryBucketed("cloudflare", T0, MINUTE)).toEqual([]);

    db.at(T0).insertPing("cloudflare", "1.1.1.1", true, 10);
    // Fenêtre entièrement postérieure aux données.
    expect(
      db.store.getPingHistoryBucketed("cloudflare", T0 + DAY, MINUTE),
    ).toEqual([]);
    // Cible jamais sondée.
    expect(db.store.getPingHistoryBucketed("inconnue", T0, MINUTE)).toEqual([]);
  });

  test("ramène 24 h de mesures à 360 points ordonnés", () => {
    const db = createStore();
    // Une sonde par minute pendant 24 h : le volume que le front ne peut pas
    // tracer brut (à 5 s sur 7 j, c'est ~120k lignes).
    for (let i = 0; i < 1440; i++) {
      db.at(T0 + i * MINUTE).insertPing("cloudflare", "1.1.1.1", true, i % 50);
    }
    expect(db.count()).toBe(1440);

    // bucketMs tel que le calcule la route : fenêtre / 360.
    const rows = db.store.getPingHistoryBucketed(
      "cloudflare",
      T0,
      Math.round(DAY / 360),
    );
    expect(rows).toHaveLength(360);
    expect(rows[0]!.ts).toBe(T0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.ts).toBeGreaterThan(rows[i - 1]!.ts);
    }
  });

  test("une fenêtre de 7 j reste sous ~360 points", () => {
    const db = createStore();
    // Une sonde par heure sur 7 j, soit 168 lignes réparties sur toute la
    // fenêtre : le bucket de 7 j/360 (28 min) en garde une par mesure.
    for (let i = 0; i < 168; i++) {
      db.at(T0 + i * HOUR).insertPing("remote", "83.204.110.38", true, 30);
    }

    const rows = db.store.getPingHistoryBucketed(
      "remote",
      T0,
      Math.round((7 * DAY) / 360),
    );
    expect(rows.length).toBeLessThanOrEqual(361);
    expect(rows).toHaveLength(168);
  });
});

describe("pruneOldPings — rétention 7 jours", () => {
  const NOW = T0 + 30 * DAY;

  test("supprime au-delà de 7 j et garde la mesure exactement sur le seuil", () => {
    const db = createStore();
    db.at(NOW - 8 * DAY).insertPing("cloudflare", "1.1.1.1", true, 10);
    db.at(NOW - 7 * DAY - 1).insertPing("cloudflare", "1.1.1.1", true, 20);
    db.at(NOW - 7 * DAY).insertPing("cloudflare", "1.1.1.1", true, 30);
    db.at(NOW - HOUR).insertPing("cloudflare", "1.1.1.1", true, 40);

    db.at(NOW).pruneOldPings();

    // Seuil strict : la mesure pile à -7 j survit, celle une milliseconde plus
    // ancienne part — c'est la fenêtre exacte que le graphe front demande.
    expect(db.rawRows().map((r) => r.ts)).toEqual([NOW - 7 * DAY, NOW - HOUR]);
  });

  test("ne touche à rien quand tout est dans la fenêtre", () => {
    const db = createStore();
    db.at(NOW - 6 * DAY).insertPing("cloudflare", "1.1.1.1", true, 10);
    db.at(NOW - MINUTE).insertPing("cloudflare", "1.1.1.1", true, 20);

    db.at(NOW).pruneOldPings();
    expect(db.count()).toBe(2);
  });

  test("purge toutes les cibles, et une base vide reste vide", () => {
    const db = createStore();
    db.at(NOW).pruneOldPings();
    expect(db.count()).toBe(0);

    for (const [target, host] of [
      ["cloudflare", "1.1.1.1"],
      ["orange", "192.168.1.1"],
      ["remote", "83.204.110.38"],
    ] as const) {
      db.at(NOW - 10 * DAY).insertPing(target, host, true, 10);
      db.at(NOW - MINUTE).insertPing(target, host, true, 10);
    }

    db.at(NOW).pruneOldPings();
    expect(db.count()).toBe(3);
    expect(db.rawRows().map((r) => r.target).sort()).toEqual([
      "cloudflare",
      "orange",
      "remote",
    ]);
  });

  test("l'historique relu après purge ne contient plus les mesures expirées", () => {
    const db = createStore();
    db.at(NOW - 10 * DAY).insertPing("cloudflare", "1.1.1.1", true, 10);
    db.at(NOW - HOUR).insertPing("cloudflare", "1.1.1.1", true, 20);

    db.at(NOW).pruneOldPings();

    // Même en demandant plus large que la rétention, la purge borne ce que le
    // front peut afficher.
    const rows = db.store.getPingHistoryBucketed(
      "cloudflare",
      NOW - 30 * DAY,
      HOUR,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latencyMs).toBe(20);
  });
});
