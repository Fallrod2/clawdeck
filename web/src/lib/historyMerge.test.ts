import { describe, expect, test } from "bun:test";
import { HISTORY_MATCH_WINDOW_MS, mergeHistory } from "./historyMerge";
import type { ChatMessage } from "./chatTypes";

const T = new Date(2026, 6, 25, 12, 0, 0).getTime();

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "user",
    text: "bonjour",
    timestamp: T,
    pending: false,
    toolCalls: [],
    ...overrides,
  };
}

describe("mergeHistory", () => {
  test("transcript vide : l'historique est adopté tel quel", () => {
    const incoming = [msg({ id: "h1" }), msg({ id: "h2", timestamp: T + 1_000 })];
    expect(mergeHistory([], incoming)).toEqual(incoming);
  });

  test("historique vide : le transcript est rendu intact", () => {
    const existing = [msg({ id: "a" })];
    expect(mergeHistory(existing, [])).toBe(existing);
  });

  test("ajoute le message arrivé pendant la coupure", () => {
    // Le cas qui motive tout le module : la réponse est arrivée alors que la
    // WebSocket était tombée, elle n'existe que dans l'historique.
    const existing = [msg({ id: "a", text: "salut" })];
    const incoming = [
      msg({ id: "h1", text: "salut" }),
      msg({ id: "h2", role: "assistant", text: "réponse manquée", timestamp: T + 30_000 }),
    ];
    const merged = mergeHistory(existing, incoming);
    expect(merged.map((m) => m.text)).toEqual(["salut", "réponse manquée"]);
  });

  test("ne duplique pas un message déjà affiché sous un autre id", () => {
    // L'historique redate le même message à la seconde près : c'est le même,
    // reçu par le flux live.
    const existing = [msg({ id: "sess-1", text: "salut", timestamp: T })];
    const incoming = [msg({ id: "h1", text: "salut", timestamp: T + 800 })];
    expect(mergeHistory(existing, incoming)).toHaveLength(1);
  });

  test("au-delà de la fenêtre, un texte identique est un vrai nouveau message", () => {
    const existing = [msg({ id: "sess-1", text: "ok", timestamp: T })];
    const incoming = [msg({ id: "h1", text: "ok", timestamp: T + HISTORY_MATCH_WINDOW_MS + 1 })];
    expect(mergeHistory(existing, incoming)).toHaveLength(2);
  });

  test("ne réinjecte jamais du passé antérieur au dernier message connu", () => {
    const existing = [msg({ id: "a", text: "récent", timestamp: T })];
    const incoming = [msg({ id: "h0", text: "très vieux", timestamp: T - 600_000 })];
    expect(mergeHistory(existing, incoming)).toHaveLength(1);
  });

  test("ne supprime, ne réordonne et ne modifie aucun message existant", () => {
    const existing = [
      msg({ id: "a", text: "un", timestamp: T }),
      msg({ id: "b", text: "deux", timestamp: T + 1_000 }),
    ];
    const merged = mergeHistory(existing, [
      msg({ id: "h", text: "trois", timestamp: T + 60_000 }),
    ]);
    expect(merged.slice(0, 2)).toEqual(existing);
    expect(merged).toHaveLength(3);
  });

  test("un envoi en cours n'est pas pris comme borne temporelle", () => {
    // Son horodatage est local ; s'en servir comme borne écarterait des
    // messages gateway légitimes plus anciens de quelques millisecondes.
    const existing = [
      msg({ id: "a", text: "ancien", timestamp: T }),
      msg({ id: "local-1", text: "en vol", timestamp: T + 120_000, sendState: "sending" }),
    ];
    const incoming = [msg({ id: "h", role: "assistant", text: "manqué", timestamp: T + 30_000 })];
    expect(mergeHistory(existing, incoming)).toHaveLength(3);
  });

  test("transcript entièrement en vol : on s'abstient plutôt que risquer un doublon", () => {
    const existing = [msg({ id: "local-1", text: "en vol", sendState: "sending" })];
    const incoming = [msg({ id: "h", text: "en vol", timestamp: T + 100 })];
    expect(mergeHistory(existing, incoming)).toBe(existing);
  });

  test("une réponse en streaming ne sert pas non plus de borne", () => {
    const existing = [
      msg({ id: "a", text: "question", timestamp: T }),
      msg({ id: "run-1", role: "assistant", text: "en train", timestamp: T + 90_000, pending: true }),
    ];
    const incoming = [msg({ id: "h", role: "assistant", text: "autre", timestamp: T + 10_000 })];
    expect(mergeHistory(existing, incoming)).toHaveLength(3);
  });

  test("deux entrées identiques dans l'historique lui-même ne comptent qu'une fois", () => {
    const existing = [msg({ id: "a", text: "début", timestamp: T })];
    const incoming = [
      msg({ id: "h1", text: "bis", timestamp: T + 20_000 }),
      msg({ id: "h2", text: "bis", timestamp: T + 20_500 }),
    ];
    expect(mergeHistory(existing, incoming)).toHaveLength(2);
  });

  test("rôles différents : un même texte n'est pas confondu", () => {
    const existing = [msg({ id: "a", role: "user", text: "ok", timestamp: T })];
    const incoming = [msg({ id: "h", role: "assistant", text: "ok", timestamp: T + 100 })];
    expect(mergeHistory(existing, incoming)).toHaveLength(2);
  });
});
