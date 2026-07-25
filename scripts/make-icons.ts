// scripts/make-icons.ts — génère les icônes d'application depuis une source SVG.
//
// La machine n'a aucun outil de traitement d'image ; le Chromium de Playwright,
// déjà installé pour la vérification visuelle, sert de moteur de rendu. Les
// PNG produits sont COMMITÉS (ils font partie du produit) — ce script n'est à
// relancer que si l'identité visuelle change.
//
//   bun scripts/make-icons.ts
//
// Le dessin reprend le badge du bandeau d'en-tête : monogramme « cd » sur
// carré sombre, accent menthe. Cohérence avant originalité — l'icône doit se
// reconnaître à côté du dashboard lui-même.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = new URL("../web/public/", import.meta.url).pathname;

// Tailles utiles : 180 pour l'écran d'accueil iOS (apple-touch-icon), 192 et
// 512 pour le manifeste web, 32 pour l'onglet.
const SIZES = [32, 180, 192, 512];

// `maskable` sur Android rogne jusqu'à 20 % : le monogramme reste dans la
// zone sûre centrale, d'où le fond plein bord à bord et le glyphe compact.
function svg(size: number): string {
  const radius = Math.round(size * 0.22);
  const fontSize = Math.round(size * 0.34);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#0d1112"/>
  <rect x="${size * 0.06}" y="${size * 0.06}" width="${size * 0.88}" height="${size * 0.88}" rx="${radius * 0.8}"
        fill="none" stroke="#65d6bd" stroke-opacity="0.28" stroke-width="${Math.max(1, size * 0.02)}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="IBM Plex Mono, ui-monospace, monospace" font-size="${fontSize}"
        font-weight="600" fill="#65d6bd" letter-spacing="${size * 0.01}">cd</text>
</svg>`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const size of SIZES) {
    const markup = svg(size);
    // La source SVG de la plus grande taille est conservée : elle documente le
    // dessin et permet de régénérer sans relire ce script.
    if (size === 512) writeFileSync(join(OUT_DIR, "icone.svg"), `${markup}\n`);

    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}</style>${markup}`,
      { waitUntil: "load" },
    );
    const file = join(OUT_DIR, `icone-${size}.png`);
    await page.screenshot({ path: file, omitBackground: true });
    await page.close();
    console.log(`écrit  ${file}`);
  }

  await browser.close();
}

await main();
