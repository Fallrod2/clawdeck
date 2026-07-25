// scripts/demo-shots.ts — captures du banc de rendu (web/demo.html).
//
// Complète scripts/screenshot.ts : celui-ci photographie l'application réelle,
// celui-là les états qu'on ne peut PAS produire à la demande sans solliciter
// l'agent — bloc de code, appel d'outil en erreur, raisonnement, streaming,
// échec d'envoi. Voir web/src/demo.tsx.
//
//   bun scripts/demo-shots.ts
//
// Le serveur Vite est démarré et arrêté par ce script : un outil de
// vérification qui exige une commande préalable finit par ne plus être lancé.
// Le banc n'existe qu'en développement — Vite ne construit qu'index.html en
// production (vérifié : web/dist ne contient pas demo.html).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.argv[2] ?? "/tmp/clawdeck-shots";
// `localhost` et non `127.0.0.1` : Vite n'écoute que sur le premier.
const URL_DEMO = "http://localhost:5174/demo.html";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 1600 },
  { name: "bureau", width: 1280, height: 1800 },
];

// Attend que Vite réponde, plutôt qu'un délai fixe qui serait soit trop long
// soit insuffisant selon la charge de la machine.
async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // serveur pas encore levé
    }
    if (Date.now() > deadline) throw new Error(`serveur de démonstration injoignable : ${url}`);
    await Bun.sleep(250);
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const vite = Bun.spawn(["bun", "run", "--cwd", "web", "demo"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "ignore",
  });

  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    await waitForServer(URL_DEMO);
  } catch (error) {
    vite.kill();
    await browser.close();
    throw error;
  }

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      colorScheme: "dark",
      locale: "fr-FR",
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`[${viewport.name}] console: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`[${viewport.name}] exception: ${err.message}`));

    await page.goto(URL_DEMO, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);

    // Le panneau a son PROPRE défilement interne : une capture pleine page ne
    // montrerait que le bas de la conversation (l'autoscroll s'y place). On
    // libère les contraintes de hauteur pour que tout le fil tienne dans la
    // capture — c'est le seul moyen de juger les états du haut.
    await page.evaluate(() => {
      const panel = document.querySelector("section");
      if (panel instanceof HTMLElement) {
        panel.style.height = "auto";
        panel.style.maxHeight = "none";
        panel.style.minHeight = "0";
      }
      const log = document.querySelector('[role="log"]');
      if (log instanceof HTMLElement) {
        log.style.height = "auto";
        log.style.overflow = "visible";
        const wrapper = log.parentElement;
        if (wrapper instanceof HTMLElement) wrapper.style.overflow = "visible";
      }
    });
    await page.waitForTimeout(300);

    // Les blocs repliables sont fermés par défaut : on photographie les deux
    // états, c'est justement le détail qu'on ne peut pas juger autrement.
    const file = join(OUT_DIR, `banc-${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`écrit  ${file}`);

    await page.evaluate(() => {
      for (const d of document.querySelectorAll("details")) d.open = true;
    });
    await page.waitForTimeout(400);
    const opened = join(OUT_DIR, `banc-${viewport.name}-deplie.png`);
    await page.screenshot({ path: opened, fullPage: true });
    console.log(`écrit  ${opened}`);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) problems.push(`[${viewport.name}] débordement horizontal de ${overflow} px`);

    await context.close();
  }

  await browser.close();
  vite.kill();
  if (problems.length) {
    console.log(`\n${problems.length} problème(s) :`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\nAucune erreur console ni débordement horizontal.");
  }
}

await main();
