// src/db.ts — persistance SQLite de l'historique des pings uniquement
// (voir CLAUDE.md : le dashboard ne duplique jamais l'état d'OpenClaw).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEnv } from "./env";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours (voir graphe front)

export interface PingRow {
  ts: number;
  ok: number;
  latencyMs: number | null;
}

export interface PingStore {
  insertPing(
    target: string,
    host: string,
    ok: boolean,
    latencyMs: number | null,
  ): void;
  pruneOldPings(): void;
  getPingHistoryBucketed(
    target: string,
    sinceMs: number,
    bucketMs: number,
  ): PingRow[];
  close(): void;
}

// Schéma et requêtes appliqués à une base DÉJÀ ouverte, avec horloge
// injectable. Extrait en fabrique parce que la base de production est un
// fichier unique, partagé avec le backend en cours d'exécution : les tests
// doivent pouvoir travailler sur une base en mémoire et piloter le temps pour
// éprouver la rétention (voir db.test.ts).
export function createPingStore(
  database: Database,
  now: () => number = Date.now,
): PingStore {
  database.exec("PRAGMA journal_mode = WAL;");
  database.run(`
    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      host TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      latency_ms REAL
    );
  `);
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_pings_target_ts ON pings (target, ts);",
  );

  return {
    insertPing(target, host, ok, latencyMs) {
      database.run(
        "INSERT INTO pings (target, host, ts, ok, latency_ms) VALUES (?, ?, ?, ?, ?)",
        [target, host, now(), ok ? 1 : 0, latencyMs],
      );
    },

    pruneOldPings() {
      database.run("DELETE FROM pings WHERE ts < ?", [now() - RETENTION_MS]);
    },

    // Historique bucketé : le front demande jusqu'à 7j, ce qui représente ~120k
    // lignes brutes à résolution 5s — trop pour un tracé SVG côté client. On
    // agrège donc côté SQL en ~360 points quel que soit l'intervalle demandé.
    getPingHistoryBucketed(target, sinceMs, bucketMs) {
      return database
        .query(
          `SELECT
             (ts / ?) * ? as ts,
             MIN(ok) as ok,
             AVG(latency_ms) as latencyMs
           FROM pings
           WHERE target = ? AND ts >= ?
           GROUP BY ts / ?
           ORDER BY ts ASC`,
        )
        .all(bucketMs, bucketMs, target, sinceMs, bucketMs) as PingRow[];
    },

    close() {
      database.close();
    },
  };
}

// Base de production, ouverte à la PREMIÈRE utilisation et jamais au simple
// import : importer index.ts (routes) dans un test ne doit ni créer ni
// verrouiller le fichier réel.
let store: PingStore | null = null;

function activeStore(): PingStore {
  if (!store) {
    mkdirSync(dirname(getEnv().dbPath), { recursive: true });
    store = createPingStore(new Database(getEnv().dbPath));
  }
  return store;
}

// Point d'injection réservé aux tests : substitue la base du singleton avant
// tout accès, pour qu'aucun test n'ouvre celle de production (index.test.ts).
export function usePingStore(next: PingStore | null) {
  store = next;
}

export function insertPing(
  target: string,
  host: string,
  ok: boolean,
  latencyMs: number | null,
) {
  activeStore().insertPing(target, host, ok, latencyMs);
}

export function pruneOldPings() {
  activeStore().pruneOldPings();
}

export function getPingHistoryBucketed(
  target: string,
  sinceMs: number,
  bucketMs: number,
): PingRow[] {
  return activeStore().getPingHistoryBucketed(target, sinceMs, bucketMs);
}

// Arrêt : ne rouvre jamais la base si elle n'a jamais servi.
export function closeDatabase() {
  store?.close();
  store = null;
}
