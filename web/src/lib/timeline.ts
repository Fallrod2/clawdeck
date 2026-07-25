// src/lib/timeline.ts — mise en forme temporelle du transcript.
//
// Le fil brut répète l'auteur et l'heure sur CHAQUE bulle, y compris pour
// cinq messages envoyés dans la même minute. On regroupe donc les messages
// consécutifs du même auteur et de même provenance, et on insère un
// séparateur quand le jour calendaire change — deux repères que tout client
// de messagerie possède et dont l'absence rend un long fil illisible.

import type { ChatMessage, MessageOrigin } from "./chatTypes";

/** Au-delà de ce silence entre deux messages, on ouvre un nouveau groupe. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export interface MessageGroup {
  kind: "group";
  key: string;
  role: "user" | "assistant";
  /** Provenance commune au groupe (canal externe), sinon absente. */
  origin?: MessageOrigin;
  /** Heure du premier message : celle affichée en tête de groupe. */
  timestamp: number;
  messages: ChatMessage[];
}

export interface DayMarker {
  kind: "day";
  key: string;
  timestamp: number;
}

export type TimelineItem = DayMarker | MessageGroup;

function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// Deux messages appartiennent au même groupe s'ils ont le même auteur, la
// même provenance, et sont proches dans le temps. La provenance compte :
// un message reçu de WhatsApp ne doit pas se fondre dans une salve écrite
// depuis le dashboard, sinon l'étiquette « via WhatsApp » du groupe mentirait
// sur une partie de son contenu.
function joinsGroup(group: MessageGroup, message: ChatMessage): boolean {
  if (group.role !== message.role) return false;
  if (group.origin?.channel !== message.origin?.channel) return false;
  const previous = group.messages[group.messages.length - 1];
  if (!previous) return false;
  if (!sameDay(previous.timestamp, message.timestamp)) return false;
  return message.timestamp - previous.timestamp <= GROUP_WINDOW_MS;
}

/**
 * Transforme le transcript en suite de marqueurs de jour et de groupes.
 * L'ordre des messages est conservé tel quel : c'est la source de vérité,
 * cette fonction ne trie ni ne déduplique rien.
 */
export function buildTimeline(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let current: MessageGroup | null = null;

  for (const message of messages) {
    // Les groupes étant contigus, le dernier message du groupe courant est
    // aussi le message précédent du fil.
    const previous = current?.messages[current.messages.length - 1];
    if (!previous || !sameDay(previous.timestamp, message.timestamp)) {
      items.push({
        kind: "day",
        key: `day-${new Date(message.timestamp).toDateString()}`,
        timestamp: message.timestamp,
      });
      current = null;
    }

    if (current && joinsGroup(current, message)) {
      current.messages.push(message);
      continue;
    }

    current = {
      kind: "group",
      key: `group-${message.id}`,
      role: message.role,
      ...(message.origin ? { origin: message.origin } : {}),
      timestamp: message.timestamp,
      messages: [message],
    };
    items.push(current);
  }

  return items;
}

/**
 * Libellé d'un marqueur de jour, relatif quand c'est utile : personne ne lit
 * « samedi 25 juillet » pour dire « aujourd'hui ». `now` est un paramètre
 * pour rester testable.
 */
export function formatDayLabel(timestamp: number, now: number): string {
  if (sameDay(timestamp, now)) return "Aujourd'hui";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(timestamp, yesterday.getTime())) return "Hier";

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
