// src/lib/chatSearch.ts — recherche dans le transcript DÉJÀ CHARGÉ (voir
// components/ChatSearch.tsx pour la barre qui l'expose).
//
// Portée assumée : useChat garde au plus 500 messages en mémoire et clawdeck
// ne duplique jamais l'historique d'OpenClaw (CLAUDE.md). Il n'y a donc rien à
// interroger côté serveur — cette recherche ne peut porter que sur ce qui est
// affiché, et l'interface doit le dire plutôt que de laisser croire à une
// recherche exhaustive.
//
// Deux contraintes dictent l'implémentation :
//  1. Interface française : « resume » doit trouver « résumé ». On compare donc
//     des textes PLIÉS (sans casse ni diacritiques). Mais le pliage change les
//     longueurs — la table d'offsets ramène chaque occurrence sur les indices
//     du texte ORIGINAL, les seuls utilisables pour surligner.
//  2. La requête vient d'un champ libre. Elle n'est JAMAIS compilée en regex :
//     `indexOf` sur le texte plié suffit, ce qui rend l'échappement inutile
//     donc impossible à oublier — « c.* » ou « ( » se cherchent littéralement.

import type { ChatMessage } from "./chatTypes";

// Plafond de collecte. Une requête d'une lettre sur 500 messages produit des
// dizaines de milliers d'occurrences : les surligner toutes fige le rendu pour
// une navigation qui n'a de toute façon aucun sens à cette échelle. On coupe,
// et le compteur affiche « 500+ » plutôt que de mentir sur le total.
export const MAX_MATCHES = 500;

export interface SearchMatch {
  /** Rang de l'occurrence dans l'ensemble du résultat (0-based). */
  ordinal: number;
  messageId: string;
  /** Position du message dans la liste fournie : sert à ordonner et à cibler. */
  messageIndex: number;
  /** Bornes dans le texte ORIGINAL du message, exploitables par `slice()`. */
  start: number;
  end: number;
}

export interface SearchResults {
  /** Requête telle que saisie, pour l'afficher dans « Aucun résultat pour … ». */
  query: string;
  /** Occurrences dans l'ordre de lecture du fil. */
  matches: SearchMatch[];
  /** Messages portant au moins une occurrence (≠ nombre d'occurrences). */
  messageCount: number;
  /** Collecte interrompue par MAX_MATCHES : le total affiché doit dire « + ». */
  truncated: boolean;
}

/** Diacritiques isolés par la décomposition NFD. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Forme comparable d'un texte : sans casse ni accents. Exportée parce que
 * c'est la définition même de « correspond » ici, et qu'elle se teste seule.
 */
export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

interface FoldedText {
  text: string;
  /** starts[i] / ends[i] : bornes, dans l'original, du caractère source de text[i]. */
  starts: number[];
  ends: number[];
}

function foldWithOffsets(value: string): FoldedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;

  // Pliage caractère par caractère plutôt que sur la chaîne entière : plier
  // d'un coup serait plus rapide mais perdrait la correspondance d'indices
  // (« é » décomposé occupe deux unités, « İ » minusculé aussi) et le
  // surlignage tomberait à côté sur tout message accentué.
  for (const char of value) {
    const next = cursor + char.length;
    // Chemin rapide ASCII : `normalize()` par caractère coûte cher et
    // l'essentiel d'un transcript n'a rien à décomposer.
    const folded = char.charCodeAt(0) < 128 ? char.toLowerCase() : foldForSearch(char);

    if (!folded) {
      // Diacritique isolé (texte déjà décomposé en amont) : il n'ajoute rien
      // au texte plié mais doit rester DANS l'occurrence, sinon on surlignerait
      // le « e » en laissant son accent hors de la marque.
      if (ends.length > 0) ends[ends.length - 1] = next;
      cursor = next;
      continue;
    }

    for (let i = 0; i < folded.length; i += 1) {
      starts.push(cursor);
      ends.push(next);
    }
    text += folded;
    cursor = next;
  }

  return { text, starts, ends };
}

/**
 * Occurrences de `query` dans les messages fournis, dans l'ordre du fil.
 * L'ordre reçu est conservé : cette fonction ne trie ni ne déduplique rien.
 */
export function searchMessages(messages: ChatMessage[], query: string): SearchResults {
  const needle = foldForSearch(query);
  // Requête vide ou blanche : aucun résultat, surtout pas « tout le fil ».
  // Une requête faite d'espaces significatifs (« le ») reste cherchable telle
  // quelle : seule la requête ENTIÈREMENT blanche est neutralisée.
  if (!needle.trim()) {
    return { query, matches: [], messageCount: 0, truncated: false };
  }

  const matches: SearchMatch[] = [];
  let messageCount = 0;
  let truncated = false;

  for (let index = 0; index < messages.length; index += 1) {
    if (truncated) break;
    const message = messages[index];
    // Message sans texte : appel d'outil seul, ou réponse dont le premier
    // delta n'est pas encore arrivé. Rien à chercher, et surtout rien à
    // compter comme résultat.
    if (!message || !message.text) continue;

    const folded = foldWithOffsets(message.text);
    let found = false;
    let from = 0;

    for (;;) {
      const at = folded.text.indexOf(needle, from);
      if (at < 0) break;
      const last = at + needle.length - 1;
      matches.push({
        ordinal: matches.length,
        messageId: message.id,
        messageIndex: index,
        start: folded.starts[at] ?? 0,
        end: folded.ends[last] ?? message.text.length,
      });
      found = true;
      // Occurrences non chevauchantes : « aa » dans « aaa » compte une fois,
      // comme dans la recherche d'un navigateur. Deux marques qui se
      // recouvrent seraient de toute façon irreprésentables à l'écran.
      from = at + needle.length;
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
    }

    if (found) messageCount += 1;
  }

  return { query, matches, messageCount, truncated };
}

/** Occurrences regroupées par message, pour le rendu du surlignage. */
export function groupMatchesByMessage(matches: SearchMatch[]): Map<string, SearchMatch[]> {
  const byMessage = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = byMessage.get(match.messageId);
    if (list) list.push(match);
    else byMessage.set(match.messageId, [match]);
  }
  return byMessage;
}

export interface TextSegment {
  text: string;
  /** Occurrence dont ce segment porte le texte, sinon null (texte ordinaire). */
  match: SearchMatch | null;
}

/**
 * Découpe un texte en segments surlignés / non surlignés. Les occurrences
 * doivent appartenir à CE message et être ordonnées (sortie de `searchMessages`).
 * Les bornes incohérentes sont ignorées plutôt que rendues : le transcript peut
 * avoir changé (streaming) entre le calcul et le rendu, et un `slice()` à côté
 * afficherait un texte faux.
 */
export function splitByMatches(text: string, matches: SearchMatch[]): TextSegment[] {
  if (matches.length === 0) return text ? [{ text, match: null }] : [];

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor || match.end > text.length || match.end <= match.start) continue;
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), match: null });
    segments.push({ text: text.slice(match.start, match.end), match });
    cursor = match.end;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: null });
  return segments;
}
