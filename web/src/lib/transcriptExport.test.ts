import { describe, expect, test } from "bun:test";
import { buildTranscriptMarkdown, exportFileName } from "./transcriptExport";
import type { ChatMessage } from "./chatTypes";

const T = new Date(2026, 6, 25, 14, 30, 0).getTime();
const DAY = 24 * 60 * 60_000;

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

describe("buildTranscriptMarkdown", () => {
  test("annonce toujours le périmètre réel", () => {
    // Un fichier daté et bien mis en forme serait sinon pris pour
    // l'historique complet d'OpenClaw — ce qu'il n'est jamais.
    const md = buildTranscriptMarkdown([msg({ id: "a" })], T);
    expect(md).toContain("pas l'historique complet d'OpenClaw");
    expect(md).toContain("1 message —");
  });

  test("transcript vide : le dit, sans prétendre exporter quoi que ce soit", () => {
    const md = buildTranscriptMarkdown([], T);
    expect(md).toContain("Aucun message chargé");
    expect(md).not.toContain("historique complet");
  });

  test("un titre de jour par journée, pas un par message", () => {
    const md = buildTranscriptMarkdown(
      [
        msg({ id: "a", timestamp: T }),
        msg({ id: "b", timestamp: T + 60_000 }),
        msg({ id: "c", timestamp: T + DAY }),
      ],
      T + DAY,
    );
    expect(md.match(/^## /gm)).toHaveLength(2);
  });

  test("l'auteur et la provenance sont portés par chaque message", () => {
    const md = buildTranscriptMarkdown(
      [
        msg({ id: "a", role: "user", origin: { channel: "whatsapp" } }),
        msg({ id: "b", role: "assistant", text: "réponse" }),
      ],
      T,
    );
    expect(md).toContain("### Vous — 14:30 · via whatsapp");
    expect(md).toContain("### OpenClaw — 14:30");
  });

  test("les appels d'outils sont résumés avec leur issue", () => {
    const md = buildTranscriptMarkdown(
      [
        msg({
          id: "a",
          role: "assistant",
          text: "voilà",
          toolCalls: [
            { id: "t", name: "exec", title: "bun test", phase: "result", startedAt: T, durationMs: 4200, exitCode: 1, isError: true },
          ],
        }),
      ],
      T,
    );
    expect(md).toContain("`bun test`");
    expect(md).toContain("erreur");
    expect(md).toContain("4200 ms");
    expect(md).toContain("sortie 1");
  });

  test("un média est cité par son chemin, jamais embarqué", () => {
    // Un export Markdown n'a pas à transporter des octets : le fichier reste
    // dans le workspace de l'agent.
    const md = buildTranscriptMarkdown(
      [msg({ id: "a", media: [{ path: "/w/media/x.ogg", mime: "audio/ogg" }] })],
      T,
    );
    expect(md).toContain("/w/media/x.ogg");
    expect(md).not.toContain("base64");
  });

  test("aucune ligne vide de plus de deux consécutives", () => {
    // Le document doit rester lisible dans un éditeur brut.
    const md = buildTranscriptMarkdown(
      [msg({ id: "a", role: "assistant", text: "x", reasoning: "parce que" }), msg({ id: "b" })],
      T,
    );
    expect(md).not.toMatch(/\n{3,}/);
  });

  test("se termine par un saut de ligne unique", () => {
    const md = buildTranscriptMarkdown([msg({ id: "a" })], T);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

describe("exportFileName", () => {
  test("nom horodaté, triable et sans caractère problématique", () => {
    expect(exportFileName(T)).toBe("clawdeck-conversation-20260725-1430.md");
    expect(exportFileName(T)).not.toMatch(/[\s:/\\]/);
  });
});
