// src/db.ts — persistance SQLite de l'historique des pings uniquement
// (voir CLAUDE.md : le dashboard ne duplique jamais l'état d'OpenClaw).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env";

mkdirSync(dirname(env.dbPath), { recursive: true });

export const db = new Database(env.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.run(`
  CREATE TABLE IF NOT EXISTS pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    host TEXT NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms REAL
  );
`);
db.run(
  "CREATE INDEX IF NOT EXISTS idx_pings_target_ts ON pings (target, ts);",
);

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours (voir graphe front)

export function insertPing(
  target: string,
  host: string,
  ok: boolean,
  latencyMs: number | null,
) {
  db.run(
    "INSERT INTO pings (target, host, ts, ok, latency_ms) VALUES (?, ?, ?, ?, ?)",
    [target, host, Date.now(), ok ? 1 : 0, latencyMs],
  );
}

export function pruneOldPings() {
  db.run("DELETE FROM pings WHERE ts < ?", [Date.now() - RETENTION_MS]);
}

export interface PingRow {
  ts: number;
  ok: number;
  latencyMs: number | null;
}

// Historique bucketé : le front demande jusqu'à 7j, ce qui représente ~120k
// lignes brutes à résolution 5s — trop pour un tracé SVG côté client. On agrège
// donc côté SQL en ~360 points quel que soit l'intervalle demandé.
export function getPingHistoryBucketed(
  target: string,
  sinceMs: number,
  bucketMs: number,
): PingRow[] {
  return db
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
}
