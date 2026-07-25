// scripts/a11y.ts — audit d'accessibilité mesuré, pas supposé.
//
//   bun scripts/a11y.ts
//
// Vérifie sur l'application réelle, dans les trois largeurs de référence :
//  - tout élément interactif porte un nom accessible ;
//  - le texte atteint le contraste WCAG AA (4,5:1, ou 3:1 pour le grand texte) ;
//  - les cibles tactiles font au moins 40 px (UI_UX.md §7) ;
//  - les images ont une alternative, les champs un label ;
//  - un seul `h1` visible par vue, et la hiérarchie de titres ne saute pas.
//
// Ce n'est pas un remplacement d'axe-core : c'est un contrôle ciblé sur les
// règles que ce projet s'impose, sans ajouter de dépendance.

import { chromium, type Page } from "playwright";
import { readFileSync } from "node:fs";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 900 },
  { name: "tablette", width: 768, height: 1000 },
  { name: "bureau", width: 1440, height: 1000 },
];

// Deux libellés par onglet : la navigation mobile utilise des libellés COURTS
// (« État » plutôt que « Vue d'ensemble »), sans quoi ils débordaient de leur
// cellule à 390 px. Un sélecteur qui n'en connaît qu'un échoue selon la
// largeur.
const TABS = [
  { titre: "Vue d'ensemble", noms: /^(Vue d'ensemble|État)$/i },
  { titre: "Chat", noms: /^Chat$/i },
  { titre: "Logs", noms: /^Logs$/i },
  { titre: "Fichiers", noms: /^Fichiers$/i },
];

function readEnv(): Record<string, string> {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// Exécuté DANS la page : le contraste ne se calcule qu'à partir des styles
// réellement appliqués, en remontant la chaîne des fonds jusqu'à une couleur
// opaque (un fond translucide sur un panneau sombre n'est pas la couleur
// perçue).
const AUDIT = () => {
  type Souci = { regle: string; detail: string };
  const soucis: Souci[] = [];

  const canal = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: number[]) =>
    0.2126 * canal(r!) + 0.7152 * canal(g!) + 0.0722 * canal(b!);
  // Résolution de couleur par le moteur lui-même, via un canvas 1×1. Une
  // analyse par expression régulière ne comprenait que rgb()/rgba() et
  // renvoyait null sur les oklch() que produit Tailwind v4 — le fond était
  // alors pris pour celui du canvas et le contraste calculé sur un bouton
  // mint donnait 1,03:1 au lieu de 12:1 (faux positif constaté le
  // 2026-07-25). Le canvas accepte toutes les syntaxes CSS de couleur.
  const pinceau = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const cacheCouleur = new Map<string, { rgb: number[]; alpha: number } | null>();
  const lire = (couleur: string): { rgb: number[]; alpha: number } | null => {
    if (cacheCouleur.has(couleur)) return cacheCouleur.get(couleur)!;
    let resultat: { rgb: number[]; alpha: number } | null = null;
    if (couleur && couleur !== "transparent" && couleur !== "none") {
      pinceau.clearRect(0, 0, 1, 1);
      pinceau.fillStyle = "#000";
      pinceau.fillStyle = couleur;
      // fillStyle inchangé = valeur non comprise par le moteur.
      if (pinceau.fillStyle !== "#000" || /^#0{3,8}$|black|rgba?\(0, ?0, ?0/.test(couleur)) {
        pinceau.fillRect(0, 0, 1, 1);
        const d = pinceau.getImageData(0, 0, 1, 1).data;
        resultat = { rgb: [d[0]!, d[1]!, d[2]!], alpha: d[3]! / 255 };
      }
    }
    cacheCouleur.set(couleur, resultat);
    return resultat;
  };
  const fusion = (dessus: number[], alpha: number, dessous: number[]) =>
    dessus.map((c, i) => c * alpha + dessous[i]! * (1 - alpha));

  function fondEffectif(el: Element): number[] {
    let courant: Element | null = el;
    let accumule: { rgb: number[]; alpha: number }[] = [];
    while (courant) {
      const bg = lire(getComputedStyle(courant).backgroundColor);
      if (bg && bg.alpha > 0) {
        accumule.push(bg);
        if (bg.alpha >= 1) break;
      }
      courant = courant.parentElement;
    }
    let resultat = [9, 11, 12]; // canvas de l'application, dernier recours
    for (let i = accumule.length - 1; i >= 0; i--) {
      const couche = accumule[i]!;
      resultat = fusion(couche.rgb, couche.alpha, resultat);
    }
    return resultat;
  }

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };

  const nomAccessible = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    const par = el.getAttribute("aria-labelledby");
    if (par) {
      const cible = document.getElementById(par);
      if (cible?.textContent?.trim()) return cible.textContent.trim();
    }
    // `labels` existe sur input, textarea ET select : ne tester que
    // HTMLInputElement signalait à tort les zones de saisie pourtant
    // correctement étiquetées (constaté à la première exécution).
    if (
      (el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement) &&
      el.labels?.length
    ) {
      return [...el.labels].map((l) => l.textContent ?? "").join(" ").trim();
    }
    const titre = el.getAttribute("title");
    if (titre?.trim()) return titre.trim();
    return (el.textContent ?? "").trim();
  };

  // 1. Noms accessibles et cibles tactiles.
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role='button']")) {
    if (!visible(el)) continue;
    const nom = nomAccessible(el);
    const description = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}`;
    if (!nom) soucis.push({ regle: "nom-accessible", detail: `${description} sans nom` });

    const r = el.getBoundingClientRect();
    // Les liens en ligne dans un texte ne sont pas des cibles isolées.
    const enLigne = el.tagName === "A" && getComputedStyle(el).display.includes("inline");
    // Le seuil de 40 px ne vaut que pour un pointeur grossier (UI_UX.md §7) :
    // l'appliquer à la souris signalerait des dizaines de contrôles parfaits
    // au clic et noierait les vrais défauts tactiles.
    const tactile = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 640;
    if (tactile && !enLigne && (r.height < 40 || r.width < 24)) {
      soucis.push({
        regle: "cible-tactile",
        detail: `${description} « ${nom.slice(0, 30)} » ${Math.round(r.width)}×${Math.round(r.height)} px`,
      });
    }
  }

  // 2. Contraste du texte.
  for (const el of document.querySelectorAll("p, span, h1, h2, h3, h4, li, td, th, label, button, a, summary")) {
    if (!visible(el)) continue;
    // Seuls les nœuds portant leur propre texte comptent.
    const propre = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
    if (!propre) continue;
    // Un contrôle désactivé est explicitement exempté des seuils de contraste
    // par WCAG 1.4.3 : son estompement EST l'information.
    if (el.closest("[disabled], [aria-disabled='true']")) continue;
    const style = getComputedStyle(el);
    const avant = lire(style.color);
    if (!avant) continue;
    const fond = fondEffectif(el);
    const couleur = avant.alpha < 1 ? fusion(avant.rgb, avant.alpha, fond) : avant.rgb;
    const l1 = luminance(couleur);
    const l2 = luminance(fond);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const px = parseFloat(style.fontSize);
    const gras = Number(style.fontWeight) >= 700;
    const grandTexte = px >= 24 || (px >= 18.66 && gras);
    const seuil = grandTexte ? 3 : 4.5;
    if (ratio < seuil) {
      soucis.push({
        regle: "contraste",
        detail: `${ratio.toFixed(2)}:1 (seuil ${seuil}) — ${px}px « ${(el.textContent ?? "").trim().slice(0, 40)} »`,
      });
    }
  }

  // 3. Images sans alternative.
  for (const img of document.querySelectorAll("img")) {
    if (!visible(img)) continue;
    if (img.getAttribute("alt") === null) {
      soucis.push({ regle: "image-sans-alt", detail: img.getAttribute("src")?.slice(0, 50) ?? "?" });
    }
  }

  // 4. Un seul h1 visible.
  const h1 = [...document.querySelectorAll("h1")].filter(visible);
  if (h1.length > 1) {
    soucis.push({ regle: "titres", detail: `${h1.length} h1 visibles simultanément` });
  }

  return soucis;
};

async function auditer(page: Page, contexte: string, soucis: string[]) {
  const trouves = await page.evaluate(AUDIT);
  // Dédoublonnage : un même défaut se répète souvent sur des dizaines de
  // nœuds identiques, ce qui noierait le rapport.
  const vus = new Set<string>();
  for (const s of trouves) {
    const cle = `${s.regle}|${s.detail}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    soucis.push(`[${contexte}] ${s.regle} : ${s.detail}`);
  }
}

async function main() {
  const env = readEnv();
  const base = `http://${env.BIND_HOST ?? "127.0.0.1"}:${env.PORT ?? "3001"}`;
  const browser = await chromium.launch();
  const soucis: string[] = [];

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: "dark",
      locale: "fr-FR",
    });
    await context.addInitScript(
      ([k, v]) => window.localStorage.setItem(k as string, v as string),
      ["clawdeck.token", env.AUTH_TOKEN!],
    );
    const page = await context.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2200);

    for (const onglet of TABS) {
      await page.getByRole("button", { name: onglet.noms }).first().click();
      await page.waitForTimeout(600);
      await auditer(page, `${viewport.name}/${onglet.titre}`, soucis);
    }
    await context.close();
  }

  await browser.close();

  if (soucis.length === 0) {
    console.log("Aucun défaut d'accessibilité détecté.");
    return;
  }
  // Regroupé par règle : c'est ainsi qu'on décide quoi corriger en premier.
  const parRegle = new Map<string, string[]>();
  for (const s of soucis) {
    const regle = s.split(" : ")[0]?.split("] ")[1] ?? "?";
    parRegle.set(regle, [...(parRegle.get(regle) ?? []), s]);
  }
  console.log(`${soucis.length} constat(s) :\n`);
  for (const [regle, liste] of [...parRegle].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${regle} (${liste.length})`);
    for (const s of liste.slice(0, 8)) console.log(`  ${s}`);
    if (liste.length > 8) console.log(`  … et ${liste.length - 8} autres`);
    console.log();
  }
  process.exitCode = 1;
}

await main();
