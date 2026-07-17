// src/validate.ts — primitives partagées de validation des entrées et des
// tokens (API HTTP, WS chat, futur /notify). Voir docs/REVUE-2026-07-17.md.

import { timingSafeEqual } from "node:crypto";

// Comparaison en temps constant : ne révèle ni le contenu ni la position du
// premier octet divergent. La longueur du token n'est pas considérée secrète.
export function safeTokenEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0 || expected.length === 0) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const DEFAULT_HISTORY_HOURS = 24;
export const MAX_HISTORY_HOURS = 24 * 7;

// Borne l'historique demandé à [1, 7j]. Retourne null pour une valeur
// non numérique ou non finie : la route doit alors répondre 400, jamais
// laisser un NaN se propager jusqu'à SQLite (cf. revue, constat backend 3).
export function parseHours(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_HISTORY_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 1), MAX_HISTORY_HOURS);
}

// Taille maximale d'un message chat relayé vers la gateway (en caractères).
export const MAX_CHAT_TEXT_LENGTH = 8_000;
