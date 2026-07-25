// src/lib/historyMerge.ts — fusion de l'historique gateway dans un transcript
// qui contient DÉJÀ des messages.
//
// Le problème résolu : à la reconnexion, le backend renvoie une frame
// `history`. Tant qu'elle n'était appliquée que sur un transcript vide, tout
// message arrivé PENDANT la coupure restait invisible jusqu'à un rechargement
// complet de la page — précisément le moment où l'on veut savoir ce qu'on a
// manqué.
//
// La difficulté : l'historique ne porte pas d'identifiant stable (les ids
// `history-*` sont dérivés d'un index de tableau, ils changent d'un appel à
// l'autre). Impossible donc de dédupliquer par id ; il faut reconnaître qu'un
// message de l'historique est le MÊME que celui déjà affiché, reçu par le flux
// live sous un autre id.
//
// Parti pris : la fusion n'AJOUTE que ce qui manque. Elle ne supprime rien, ne
// réordonne rien et ne modifie aucun message existant. Un doublon manqué est
// gênant ; un message effacé ou un envoi en cours perdu serait grave.

import type { ChatMessage } from "./chatTypes";

// Tolérance de correspondance temporelle. L'historique et le flux live datent
// le même message à des instants légèrement différents (arrondi à la seconde
// côté transcript OpenClaw, milliseconde côté événement). Trop serré, on
// duplique ; trop large, deux messages identiques réellement distincts
// fusionnent — d'où une valeur de l'ordre de la poignée de secondes.
export const HISTORY_MATCH_WINDOW_MS = 5_000;

function sameContent(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role && a.text.trim() === b.text.trim();
}

/**
 * Fusionne `incoming` (historique fraîchement relu) dans `existing`.
 *
 * Ne conserve d'`incoming` que ce qui est postérieur au dernier message connu
 * ET qui ne correspond à aucun message déjà présent. Le résultat garde
 * `existing` intact en tête, dans son ordre, suivi des seuls ajouts.
 */
export function mergeHistory(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;

  // Borne basse : on ne réinjecte jamais du passé déjà affiché. Les messages
  // encore en vol (envoi en cours, réponse en streaming) sont exclus du calcul
  // — leur horodatage est local et n'a pas de sens face à celui de la gateway.
  let lastKnownAt = -Infinity;
  for (const message of existing) {
    if (message.pending || message.sendState === "sending") continue;
    if (message.timestamp > lastKnownAt) lastKnownAt = message.timestamp;
  }
  // Transcript entièrement en vol : rien de stable à quoi se comparer, on
  // s'abstient plutôt que de risquer un doublon sur l'échange en cours.
  if (lastKnownAt === -Infinity) return existing;

  const additions: ChatMessage[] = [];
  for (const candidate of incoming) {
    if (candidate.timestamp < lastKnownAt) continue;

    // Déjà là ? Un même contenu, du même auteur, à quelques secondes près,
    // est le même message reçu par l'autre chemin.
    const alreadyShown = existing.some(
      (message) =>
        sameContent(message, candidate) &&
        Math.abs(message.timestamp - candidate.timestamp) <= HISTORY_MATCH_WINDOW_MS,
    );
    if (alreadyShown) continue;

    // Ni deux fois dans l'historique lui-même (répétition légitime de l'agent
    // à quelques secondes d'intervalle exclue par la fenêtre).
    const alreadyAdded = additions.some(
      (message) =>
        sameContent(message, candidate) &&
        Math.abs(message.timestamp - candidate.timestamp) <= HISTORY_MATCH_WINDOW_MS,
    );
    if (alreadyAdded) continue;

    additions.push(candidate);
  }

  return additions.length === 0 ? existing : [...existing, ...additions];
}
