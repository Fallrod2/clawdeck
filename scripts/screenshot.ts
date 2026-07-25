// scripts/screenshot.ts — capture l'interface réelle dans un Chromium headless.
//
// Raison d'être : clawdeck tourne sur un Mac mini sans session graphique. Sans
// cet outil, aucune évolution visuelle ne peut être vérifiée autrement qu'en
// demandant à l'opérateur de regarder — ce qui rend toute refonte d'interface
// aveugle. Le script injecte le token depuis .env, visite chaque onglet et
// écrit un PNG par vue et par largeur.
//
//   bun scripts/screenshot.ts [dossier-de-sortie]
//
// Les captures ne sont PAS commitées (voir .gitignore) : ce sont des artefacts
// de vérification, pas des références visuelles à figer.

import { chromium, type Page } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.argv[2] ?? "/tmp/clawdeck-shots";

// Largeurs imposées par UI_UX.md §7 : concevoir d'abord à 320-390 px, puis
// 768 px et 1280 px.
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 900 },
  { name: "tablette", width: 768, height: 1000 },
  { name: "bureau", width: 1440, height: 1000 },
];

// Onglets tels qu'exposés par la navigation principale.
const TABS = [
  { name: "sante", label: "Vue d'ensemble" },
  { name: "chat", label: "Chat" },
  { name: "logs", label: "Logs" },
  { name: "fichiers", label: "Fichiers" },
];

function readEnv(): Record<string, string> {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// Un onglet est atteint en cliquant son bouton de navigation : passer par
// l'UI réelle plutôt que par un état interne garantit qu'on photographie ce
// que l'opérateur verrait.
async function openTab(page: Page, label: string): Promise<boolean> {
  const button = page.getByRole("button", { name: new RegExp(label, "i") }).first();
  if ((await button.count()) === 0) return false;
  await button.click();
  await page.waitForTimeout(600);
  return true;
}

async function main() {
  const env = readEnv();
  const token = env.AUTH_TOKEN;
  const base = `http://${env.BIND_HOST ?? "127.0.0.1"}:${env.PORT ?? "3001"}`;
  if (!token) throw new Error("AUTH_TOKEN absent de .env");

  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const problems: string[] = [];

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      colorScheme: "dark",
      locale: "fr-FR",
    });

    // Le token vit dans localStorage : on le pose AVANT le premier rendu pour
    // ne pas photographier la porte d'authentification.
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      ["clawdeck.token", token],
    );

    const page = await context.newPage();
    // Toute erreur console est un défaut réel : on la remonte plutôt que de
    // livrer une capture qui « a l'air » correcte.
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`[${viewport.name}] console: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`[${viewport.name}] exception: ${err.message}`));

    // PAS networkidle : le dashboard maintient en permanence deux flux SSE et
    // un WebSocket ouverts, le réseau n'est jamais au repos et l'attente
    // expirerait systématiquement.
    await page.goto(base, { waitUntil: "domcontentloaded" });
    // Laisse le temps aux polices de se charger et au premier snapshot de
    // statut d'arriver, sinon on photographie des cartes « En attente… ».
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2500);

    for (const tab of TABS) {
      const opened = await openTab(page, tab.label);
      if (!opened) {
        problems.push(`[${viewport.name}] onglet introuvable : ${tab.label}`);
        continue;
      }
      const file = join(OUT_DIR, `${tab.name}-${viewport.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`écrit  ${file}`);
    }

    // Débordement horizontal : interdit par UI_UX.md §7, invisible sur une
    // capture recadrée, donc mesuré explicitement.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) problems.push(`[${viewport.name}] débordement horizontal de ${overflow} px`);

    await context.close();
  }

  await browser.close();

  if (problems.length) {
    console.log(`\n${problems.length} problème(s) détecté(s) :`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\nAucune erreur console ni débordement horizontal.");
  }
}

await main();
