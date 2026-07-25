// Verrou sur la surface d'injection du Markdown rendu dans le chat.
//
// Le texte affiché vient de l'agent, qui relaie lui-même des contenus
// extérieurs (pages web, messages reçus). Deux propriétés le rendent sûr, et
// AUCUNE des deux n'est visible à la lecture de ChatPanel.tsx — d'où ces
// tests, qui échoueront si une montée de version ou un ajout de plugin les
// retire silencieusement.
//
//  1. react-markdown filtre les URL par liste blanche de protocoles
//     (`defaultUrlTransform`), tant qu'on ne fournit pas notre propre
//     `urlTransform`. C'est ce qui neutralise `javascript:`.
//  2. Aucun `rehype-raw` n'est branché : le HTML brut reste échappé.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultUrlTransform } from "react-markdown";

describe("filtrage des URL de react-markdown", () => {
  test("neutralise les protocoles exécutables", () => {
    expect(defaultUrlTransform("javascript:alert(1)")).toBe("");
    // La casse et les espaces ne doivent pas servir de contournement.
    expect(defaultUrlTransform("JaVaScRiPt:alert(1)")).toBe("");
    expect(defaultUrlTransform("vbscript:msgbox(1)")).toBe("");
  });

  test("laisse passer ce qui est légitime dans une réponse d'agent", () => {
    expect(defaultUrlTransform("https://example.org/a?b=1#c")).toBe("https://example.org/a?b=1#c");
    expect(defaultUrlTransform("http://100.66.217.18:3001/")).toBe("http://100.66.217.18:3001/");
    expect(defaultUrlTransform("mailto:a@b.c")).toBe("mailto:a@b.c");
    // Chemin relatif : pas de protocole, rien à filtrer.
    expect(defaultUrlTransform("/assets/x.png")).toBe("/assets/x.png");
    expect(defaultUrlTransform("./notes.md")).toBe("./notes.md");
  });

  test("les `data:` d'un lien sont refusés", () => {
    // Une image `data:` est légitime (onglet Fichiers, via une balise <img>
    // que nous construisons), mais un LIEN `data:` dans du markdown reçu est
    // un vecteur classique de hameçonnage.
    expect(defaultUrlTransform("data:text/html,<script>alert(1)</script>")).toBe("");
  });
});

describe("configuration de rendu du chat", () => {
  // Les commentaires sont retirés avant analyse : le fichier EXPLIQUE qu'il
  // n'utilise pas rehype-raw, une recherche naïve trouverait donc le terme
  // dans sa propre justification et le test passerait pour de mauvaises
  // raisons (constaté à la première exécution).
  const source = readFileSync(new URL("../components/ChatPanel.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  test("aucun plugin rehype de HTML brut n'est branché", () => {
    // `rehype-raw` ferait rendre le HTML contenu dans le markdown : c'est
    // précisément ce qu'on refuse. Le test porte sur la source parce que la
    // configuration est passée en ligne au composant.
    expect(source).not.toContain("rehype-raw");
    expect(source).not.toContain("rehypeRaw");
    expect(source).not.toContain("rehypePlugins");
  });

  test("le filtrage d'URL par défaut n'est pas remplacé", () => {
    expect(source).not.toContain("urlTransform");
  });

  test("aucune insertion de HTML non échappé", () => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});
