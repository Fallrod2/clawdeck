// scripts/smoke.ts — test de fumée bout en bout de l'interface.
//
//   bun run build && bun scripts/smoke.ts
//
// Démarre une instance JETABLE du backend (port libre, base temporaire,
// identité temporaire, gateway volontairement injoignable) et pilote un
// Chromium headless dessus. Ne touche JAMAIS l'instance de production ni
// l'OpenClaw réel : la gateway pointe sur un port fermé, ce qui exerce en
// prime le chemin « dépendance indisponible ».
//
// Ce que ça couvre et que les tests unitaires ne peuvent pas voir : la porte
// d'authentification, le refus d'un mauvais token, la navigation entre
// onglets, et surtout l'absence d'erreur console — c'est ainsi qu'une
// violation de CSP ou un plantage de rendu se manifeste.

import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "jeton-de-fumee-0123456789abcdef";
const echecs: string[] = [];

function verifie(condition: boolean, description: string) {
  if (condition) {
    console.log(`  ok    ${description}`);
  } else {
    console.log(`  ÉCHEC ${description}`);
    echecs.push(description);
  }
}

async function portLibre(): Promise<number> {
  const serveur = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = serveur.port;
  serveur.stop(true);
  return port;
}

async function attendre(url: string, timeoutMs = 20_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).status > 0) return;
    } catch {
      // pas encore levé
    }
    if (Date.now() > limite) throw new Error(`backend jetable injoignable : ${url}`);
    await Bun.sleep(200);
  }
}

async function main() {
  const racine = new URL("..", import.meta.url).pathname;
  const travail = mkdtempSync(join(tmpdir(), "clawdeck-fumee-"));
  const port = await portLibre();
  // Port fermé choisi exprès : le backend doit démarrer et servir l'interface
  // même sans gateway. C'est aussi le cas réel d'un OpenClaw arrêté.
  const portGatewayMort = await portLibre();
  const base = `http://127.0.0.1:${port}`;

  const backend = Bun.spawn(["bun", "src/index.ts"], {
    cwd: racine,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: "127.0.0.1",
      AUTH_TOKEN: TOKEN,
      GATEWAY_AUTH_TOKEN: "jeton-gateway-de-fumee",
      GATEWAY_URL: `http://127.0.0.1:${portGatewayMort}`,
      DB_PATH: join(travail, "fumee.sqlite"),
      GATEWAY_DEVICE_IDENTITY_PATH: join(travail, "identite.json"),
    },
  });

  const navigateur = await chromium.launch();
  try {
    await attendre(`${base}/api/healthz`);

    const contexte = await navigateur.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "fr-FR",
    });
    const page = await contexte.newPage();
    const erreurs: string[] = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // « Failed to load resource » est journalisé par le navigateur pour
      // toute réponse HTTP en échec. Ici la gateway est éteinte VOLONTAIREMENT
      // et les routes qui en dépendent répondent 503 : c'est le comportement
      // attendu, pas un défaut. Seules les erreurs applicatives comptent.
      if (m.text().startsWith("Failed to load resource")) return;
      erreurs.push(m.text());
    });
    page.on("pageerror", (e) => erreurs.push(`exception: ${e.message}`));

    console.log("\nSonde de vie");
    const sante = await fetch(`${base}/api/healthz`);
    verifie(sante.status === 200, "/api/healthz répond 200 sans token");
    verifie(!(await sante.text()).includes(TOKEN), "/api/healthz ne divulgue aucun secret");

    console.log("\nGarde d'authentification");
    verifie((await fetch(`${base}/api/status`)).status === 401, "/api/status refuse l'absence de token");
    const mauvais = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}x` } });
    verifie(mauvais.status === 401, "/api/status refuse un token approchant");

    console.log("\nPorte d'authentification de l'interface");
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const champToken = page.locator('input[type="password"], input[type="text"]').first();
    verifie(await champToken.isVisible(), "la porte d'authentification s'affiche sans token");

    console.log("\nAccès avec le bon token");
    await contexte.addInitScript(
      ([k, v]) => window.localStorage.setItem(k as string, v as string),
      ["clawdeck.token", TOKEN],
    );
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2000);
    // `:visible` est indispensable : les panneaux restent MONTÉS et seulement
    // masqués (pour que la connexion du chat survive au changement d'onglet),
    // donc un sélecteur `h1` ordinaire renvoie toujours le premier du DOM,
    // quel que soit l'onglet actif.
    const titreVisible = () => page.locator("h1:visible").first().innerText();
    verifie((await titreVisible()).includes("Vue d'ensemble"), "la vue d'ensemble se rend");

    console.log("\nNavigation");
    for (const onglet of ["Chat", "Logs", "Fichiers"]) {
      await page.getByRole("button", { name: new RegExp(`^${onglet}$`, "i") }).first().click();
      await page.waitForTimeout(500);
      verifie((await titreVisible()).includes(onglet), `l'onglet ${onglet} s'ouvre`);
    }

    console.log("\nRobustesse");
    // La gateway est injoignable : l'interface doit le DIRE, pas planter ni
    // afficher un état vert (UI_UX.md §4 — jamais de vert sur une sonde morte).
    await page.getByRole("button", { name: /^Chat$/i }).first().click();
    await page.waitForTimeout(600);
    const texte = await page.locator("body").innerText();
    verifie(
      /indisponible|hors ligne|déconnect/i.test(texte),
      "l'indisponibilité de la gateway est annoncée",
    );

    const debordement = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    verifie(debordement <= 0, "aucun débordement horizontal");
    verifie(erreurs.length === 0, `aucune erreur console${erreurs.length ? ` (${erreurs[0]})` : ""}`);

    await contexte.close();
  } finally {
    await navigateur.close();
    backend.kill();
    await backend.exited;
    rmSync(travail, { recursive: true, force: true });
  }

  if (echecs.length) {
    console.log(`\n${echecs.length} vérification(s) en échec.`);
    process.exitCode = 1;
  } else {
    console.log("\nToutes les vérifications passent.");
  }
}

await main();
