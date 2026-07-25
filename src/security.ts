// src/security.ts — garde d'entrée HTTP : en-têtes de sécurité, auth bearer de
// l'API et sonde de vie publique. Regroupés ici pour que la liste des routes
// servies SANS token tienne sous les yeux d'un relecteur, et pour que tout cela
// se teste sans démarrer le serveur (voir security.test.ts).
//
// Le contexte dicte les choix : clawdeck est servi en http:// sur un tailnet
// privé mono-utilisateur (voir CLAUDE.md). D'où deux absences volontaires —
// pas de Strict-Transport-Security, pas d'`upgrade-insecure-requests` : les
// deux forceraient https:// sur une origine dépourvue de certificat, donc
// rendraient le dashboard inaccessible, sans rien ajouter à un transport que
// Tailscale chiffre déjà.

import type { Context, Handler, MiddlewareHandler } from "hono";
import { safeTokenEqual } from "./validate";

// Chaque directive est justifiée par ce que le front fait RÉELLEMENT (voir
// web/dist/index.html et web/src) : une CSP plus large qu'utile ne protège de
// rien, une CSP plus étroite casse une fonctionnalité en silence.
export const CSP_DIRECTIVES: Record<string, string> = {
  // Socle : tout ce qui n'est pas repris ci-dessous doit venir de cette origine.
  "default-src": "'self'",
  // Le bundle est un module externe (/assets/index-*.js) et index.html ne
  // contient aucun script inline : ni 'unsafe-inline' ni 'unsafe-eval'.
  "script-src": "'self'",
  // Vite sort la CSS dans un fichier (/assets/index-*.css). Les `style={{…}}`
  // de React passent par le CSSOM (element.style), que la CSP ne filtre pas :
  // 'unsafe-inline' serait inutile ici.
  "style-src": "'self'",
  // Polices IBM Plex auto-hébergées dans /assets/*.woff2, aucun CDN
  // (docs/UI_UX.md §3) : l'interface doit fonctionner hors ligne.
  "font-src": "'self'",
  // data: est exigé par l'aperçu d'image de l'onglet Fichiers, que le front
  // construit en `data:<mime>;base64,…` à partir de la réponse gateway.
  // blob: est exigé par les médias du chat : /api/media est protégée par le
  // bearer token, or ni <img src> ni <audio src> ne peuvent poser d'en-tête —
  // le front récupère donc l'octet par fetch et expose un blob local. Un blob:
  // ne peut être créé que par notre propre script, à partir de ce que notre
  // propre origine a servi.
  "img-src": "'self' data: blob:",
  // Même raison pour les vocaux et vidéos reçus. Sans directive explicite,
  // media- retombe sur default-src et les blob: sont refusés — constaté à
  // l'exécution le 2026-07-25, la prédiction inverse était fausse.
  "media-src": "'self' blob:",
  // Flux SSE (/api/status, /api/logs, ouverts en fetch pour porter le header
  // Authorization) et WebSocket du chat (/api/chat/ws). Depuis une page http://,
  // 'self' couvre le ws:// de même origine (CSP niveau 3).
  "connect-src": "'self'",
  // Anti-clickjacking : le dashboard pilote une machine réelle, il ne doit
  // jamais être encadré — et il n'encadre rien lui-même.
  "frame-ancestors": "'none'",
  "frame-src": "'none'",
  "object-src": "'none'",
  // Une injection ne doit pas pouvoir réécrire la base des URL relatives et
  // détourner /api/* vers un autre hôte du tailnet.
  "base-uri": "'none'",
  // Les formulaires (saisie du token, upload) sont traités en JS ; aucune
  // soumission ne doit pouvoir partir ailleurs que sur cette origine.
  "form-action": "'self'",
};

export const CONTENT_SECURITY_POLICY = Object.entries(CSP_DIRECTIVES)
  .map(([directive, value]) => `${directive} ${value}`)
  .join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  // Interdit au navigateur de deviner un type MIME : un fichier du workspace
  // rendu en text/plain ne doit jamais être ré-interprété en HTML ou en JS.
  "X-Content-Type-Options": "nosniff",
  // Un lien ouvert depuis le markdown du chat ne doit pas divulguer l'URL
  // interne du dashboard (hôte Tailscale, chemin, paramètres) au site visité.
  "Referrer-Policy": "no-referrer",
  // Doublon assumé de frame-ancestors, pour les navigateurs qui ignorent la CSP.
  "X-Frame-Options": "DENY",
  // Le front n'utilise aucune de ces API : les refuser coûte une ligne et
  // limite ce qu'un script injecté pourrait demander à l'appareil.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export const CHAT_WS_PATH = "/api/chat/ws";
export const HEALTHZ_PATH = "/api/healthz";

// Les DEUX seules routes /api/* servies sans bearer token, pour deux raisons
// distinctes. Toute entrée ajoutée ici élargit la surface exposée à quiconque
// atteint le tailnet : à justifier au cas par cas.
export const UNAUTHENTICATED_API_PATHS: readonly string[] = [
  // Handshake WebSocket : un navigateur ne peut pas poser de header
  // Authorization dessus. L'auth se fait à la première frame, sous timeout,
  // sinon le socket est fermé en 1008 (voir index.ts).
  CHAT_WS_PATH,
  // Sonde de vie du process. Hors auth par nécessité : elle sert à vérifier de
  // l'extérieur (launchd, script de déploiement, autre machine du tailnet) que
  // le process répond encore, y compris quand AUTH_TOKEN est mal configuré ou
  // en cours de rotation — cas où /api/status renverrait 401 sans distinguer
  // « backend mort » de « token faux ». Le compromis n'est acceptable que
  // parce que sa réponse ne dit rien d'autre (voir healthz).
  HEALTHZ_PATH,
];

// Réponse volontairement constante et anonyme : un 200 signifie « ce process
// sert des requêtes », rien de plus. Pas de version ni de build (empreinte
// offerte à un attaquant), pas de chemin, pas d'uptime, pas d'état
// gateway/Ollama/WhatsApp — ces diagnostics existent déjà sur /api/status,
// derrière le token.
export const healthz: Handler = (c: Context) => c.json({ status: "ok" });

export function apiBearerAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (UNAUTHENTICATED_API_PATHS.includes(c.req.path)) {
      await next();
      return;
    }
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!safeTokenEqual(token, expectedToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // Les en-têtes se posent APRÈS next() : un handler qui renvoie une Response
    // toute faite (streamSSE, serveStatic) remplace c.res, et des en-têtes
    // préparés avant seraient perdus pour ces réponses-là — c'est-à-dire pour
    // le front buildé et les flux SSE, exactement là où la CSP compte.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }
    // L'API expose l'état d'exploitation et le contenu du workspace : rien de
    // tout cela ne doit survivre dans le cache disque du navigateur. Écrase
    // volontairement le `no-cache` que Hono pose sur les flux SSE, lequel
    // autorise le stockage tant que la fraîcheur est revalidée.
    if (c.req.path.startsWith("/api/")) {
      c.header("Cache-Control", "no-store");
    }
  };
}
