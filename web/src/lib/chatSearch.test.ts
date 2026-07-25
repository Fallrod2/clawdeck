import { describe, expect, test } from "bun:test";
import {
  foldForSearch,
  groupMatchesByMessage,
  MAX_MATCHES,
  searchMessages,
  splitByMatches,
} from "./chatSearch";
import type { ChatMessage } from "./chatTypes";

function msg(id: string, text: string): ChatMessage {
  return { id, role: "assistant", text, timestamp: 0, pending: false, toolCalls: [] };
}

/** Texte réellement surligné : c'est ce que l'utilisateur verra en surbrillance. */
function highlighted(text: string, query: string): string[] {
  return searchMessages([msg("a", text)], query).matches.map((m) => text.slice(m.start, m.end));
}

describe("foldForSearch", () => {
  test("supprime casse et diacritiques", () => {
    expect(foldForSearch("RÉSUMÉ")).toBe("resume");
    expect(foldForSearch("Où çà ?")).toBe("ou ca ?");
  });
});

describe("searchMessages — requêtes neutres", () => {
  test("requête vide : aucun résultat, jamais tout le fil", () => {
    const results = searchMessages([msg("a", "bonjour")], "");
    expect(results.matches).toEqual([]);
    expect(results.messageCount).toBe(0);
    expect(results.truncated).toBe(false);
  });

  test("requête faite d'espaces seuls : aucun résultat", () => {
    expect(searchMessages([msg("a", "bonjour tout le monde")], "   ").matches).toEqual([]);
  });

  test("espace significatif dans la requête : cherché tel quel", () => {
    expect(searchMessages([msg("a", "le log de la gateway")], "e l").matches).toHaveLength(2);
  });

  test("transcript vide", () => {
    expect(searchMessages([], "gateway").matches).toEqual([]);
  });
});

describe("searchMessages — accents et casse", () => {
  test("« resume » trouve « résumé »", () => {
    expect(highlighted("Le résumé est prêt", "resume")).toEqual(["résumé"]);
  });

  test("« résumé » trouve « resume » : la tolérance va dans les deux sens", () => {
    expect(highlighted("le resume est pret", "résumé")).toEqual(["resume"]);
  });

  test("la casse est ignorée, accents compris", () => {
    expect(highlighted("RÉSUMÉ DE LA JOURNÉE", "resume")).toEqual(["RÉSUMÉ"]);
  });

  test("les bornes retombent sur le texte ORIGINAL, pas sur le texte plié", () => {
    const text = "Le résumé est prêt";
    const [match] = searchMessages([msg("a", text)], "est").matches;
    // « résumé » compte 6 caractères en composé : un décalage ici surlignerait
    // à côté sur tout message accentué.
    expect(match?.start).toBe(10);
    expect(text.slice(match!.start, match!.end)).toBe("est");
  });

  test("texte déjà décomposé : l'accent reste dans l'occurrence", () => {
    // « café » écrit e + accent combinant, comme le produisent certains claviers
    // et copier-coller. Surligner « cafe » en laissant l'accent dehors le
    // ferait flotter à l'écran.
    const text = "café chaud";
    expect(highlighted(text, "cafe")).toEqual(["café"]);
  });

  test("caractères hors plan basique : les indices restent justes", () => {
    expect(highlighted("\u{1F389} fête réussie", "fete")).toEqual(["fête"]);
  });
});

describe("searchMessages — saisie libre", () => {
  test("les caractères spéciaux de regex sont cherchés littéralement", () => {
    expect(highlighted("coût : 3 € (env.)", "(env.)")).toEqual(["(env.)"]);
    expect(highlighted("a+b", "a+b")).toEqual(["a+b"]);
    expect(highlighted("chemin [1]", "[1]")).toEqual(["[1]"]);
  });

  test("un quantificateur saisi ne matche pas comme une regex", () => {
    // « e.* » compilé en expression régulière matcherait ; ici il ne doit rien
    // trouver puisque la chaîne « e.* » n'est pas dans le texte.
    expect(highlighted("le message", "e.*")).toEqual([]);
  });

  test("une regex invalide en saisie ne fait pas exploser la recherche", () => {
    expect(() => searchMessages([msg("a", "texte ( non fermé")], "(")).not.toThrow();
    expect(highlighted("texte ( non fermé", "(")).toEqual(["("]);
  });
});

describe("searchMessages — occurrences multiples", () => {
  test("toutes les occurrences d'un même message sont retournées", () => {
    const results = searchMessages([msg("a", "log, log et encore log")], "log");
    expect(results.matches).toHaveLength(3);
    expect(results.matches.map((m) => m.start)).toEqual([0, 5, 19]);
    expect(results.messageCount).toBe(1);
  });

  test("occurrences non chevauchantes", () => {
    expect(searchMessages([msg("a", "aaa")], "aa").matches).toHaveLength(1);
  });

  test("le rang est continu à travers les messages, dans l'ordre du fil", () => {
    const results = searchMessages(
      [msg("a", "gateway gateway"), msg("b", "sans"), msg("c", "gateway")],
      "gateway",
    );
    expect(results.matches.map((m) => m.ordinal)).toEqual([0, 1, 2]);
    expect(results.matches.map((m) => m.messageId)).toEqual(["a", "a", "c"]);
    expect(results.matches.map((m) => m.messageIndex)).toEqual([0, 0, 2]);
    // Un message à deux occurrences ne compte qu'une fois comme message.
    expect(results.messageCount).toBe(2);
  });

  test("au-delà du plafond, la collecte s'arrête et le dit", () => {
    const results = searchMessages([msg("a", "a".repeat(MAX_MATCHES + 42))], "a");
    expect(results.matches).toHaveLength(MAX_MATCHES);
    expect(results.truncated).toBe(true);
  });
});

describe("searchMessages — messages sans texte", () => {
  test("un message vide est ignoré sans compter comme résultat", () => {
    const results = searchMessages([msg("vide", ""), msg("plein", "gateway")], "gateway");
    expect(results.matches.map((m) => m.messageId)).toEqual(["plein"]);
    expect(results.messageCount).toBe(1);
  });

  test("réponse en cours encore vide : aucune correspondance parasite", () => {
    const pending: ChatMessage = { ...msg("run", ""), pending: true };
    expect(searchMessages([pending], "a").matches).toEqual([]);
  });
});

describe("groupMatchesByMessage", () => {
  test("regroupe en conservant l'ordre des occurrences", () => {
    const results = searchMessages([msg("a", "ping ping"), msg("b", "ping")], "ping");
    const grouped = groupMatchesByMessage(results.matches);
    expect(grouped.get("a")).toHaveLength(2);
    expect(grouped.get("b")).toHaveLength(1);
    expect(grouped.get("a")?.map((m) => m.start)).toEqual([0, 5]);
  });
});

describe("splitByMatches", () => {
  test("sans occurrence : le texte reste d'une seule pièce", () => {
    expect(splitByMatches("bonjour", [])).toEqual([{ text: "bonjour", match: null }]);
    expect(splitByMatches("", [])).toEqual([]);
  });

  test("alterne texte et occurrences, dans l'ordre", () => {
    const text = "log, log et encore log";
    const segments = splitByMatches(text, searchMessages([msg("a", text)], "log").matches);
    expect(segments.map((s) => s.text)).toEqual(["log", ", ", "log", " et encore ", "log"]);
    expect(segments.map((s) => s.match !== null)).toEqual([true, false, true, false, true]);
    // Le texte reconstitué doit être rigoureusement l'original.
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  test("occurrence en fin de texte : pas de segment vide ajouté", () => {
    const text = "voir le log";
    const segments = splitByMatches(text, searchMessages([msg("a", text)], "log").matches);
    expect(segments).toHaveLength(2);
    expect(segments[1]?.text).toBe("log");
  });

  test("bornes hors du texte rendu : ignorées plutôt que tronquées de travers", () => {
    // Cas réel : le message a été raccourci (nouveau delta de streaming) entre
    // le calcul de la recherche et le rendu.
    const stale = searchMessages([msg("a", "gateway indisponible")], "indisponible").matches;
    expect(splitByMatches("gateway", stale)).toEqual([{ text: "gateway", match: null }]);
  });

  test("le rang de l'occurrence voyage jusqu'au segment", () => {
    const text = "log log";
    const segments = splitByMatches(text, searchMessages([msg("a", text)], "log").matches);
    expect(segments.filter((s) => s.match).map((s) => s.match?.ordinal)).toEqual([0, 1]);
  });
});
