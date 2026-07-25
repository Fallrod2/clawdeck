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

// Base64 canonique : groupes de 4 caractères de l'alphabet standard, avec au
// plus deux « = » de bourrage à la toute fin. Nécessaire parce que
// `Buffer.from(x, "base64")` ne signale jamais une entrée invalide — il jette
// silencieusement les caractères inconnus et rend des octets faux (constaté
// le 2026-07-25 : un téléversement malformé écrivait un fichier corrompu en
// répondant 200).
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isValidBase64(value: string): boolean {
  // Une chaîne vide est un contenu vide légitime (fichier vide), pas une
  // erreur de format.
  if (value.length === 0) return true;
  return BASE64_PATTERN.test(value);
}
