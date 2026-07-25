// src/env.ts — chargement et validation des variables d'environnement.
// Bun charge .env automatiquement ; voir .env.example pour la liste complète.
// Ne jamais commiter .env (voir .gitignore).
//
// La validation est centralisée dans `parseEnv` (pure et testable, voir
// env.test.ts) : toute variable malformée fait échouer le démarrage avec un
// message qui dit quoi corriger, sans jamais divulguer la valeur d'un secret
// (voir docs/REVUE-2026-07-17.md, constats backend 1, 6, 7).

import type { NtfyConfig } from "./notify";

type EnvSource = Record<string, string | undefined>;

function requiredFrom(source: EnvSource, name: string): string {
  const value = source[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante: ${name} (voir .env.example)`,
    );
  }
  return value;
}

// PORT : entier entre 1 et 65535, défaut 3001. Rejette « abc », « 0 »,
// « 70000 » — sinon un NaN atteignait Bun.serve (revue, constat 6).
function parsePort(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return 3001;
  if (!/^\d+$/.test(value)) {
    throw new Error("PORT doit être un entier entre 1 et 65535.");
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`PORT doit être un entier entre 1 et 65535 (reçu ${port}).`);
  }
  return port;
}

// AUTH_TOKEN : requis, jamais la valeur d'exemple, au moins 16 caractères.
// Le message ne contient jamais la valeur fournie.
function parseAuthToken(source: EnvSource): string {
  const value = requiredFrom(source, "AUTH_TOKEN");
  if (value === "change-me") {
    throw new Error(
      "AUTH_TOKEN a gardé la valeur d'exemple « change-me » : générer un vrai secret, par ex. `openssl rand -hex 32`.",
    );
  }
  if (value.length < 16) {
    throw new Error(
      "AUTH_TOKEN doit faire au moins 16 caractères : générer un secret avec `openssl rand -hex 32`.",
    );
  }
  return value;
}

// GATEWAY_AUTH_TOKEN : requis, jamais la valeur d'exemple.
function parseGatewayAuthToken(source: EnvSource): string {
  const value = requiredFrom(source, "GATEWAY_AUTH_TOKEN");
  if (value === "change-me") {
    throw new Error(
      "GATEWAY_AUTH_TOKEN a gardé la valeur d'exemple « change-me » : renseigner gateway.auth.token de la gateway OpenClaw.",
    );
  }
  return value;
}

// GATEWAY_URL / OLLAMA_URL : doivent parser en http:// ou https://.
// Retourne la chaîne d'origine (gatewayWsUrl en est dérivée telle quelle).
function parseHttpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} doit être une URL http:// ou https:// valide.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${name} doit utiliser le schéma http:// ou https:// (reçu « ${url.protocol} »).`,
    );
  }
  return value;
}

// Découpe une IPv4 en 4 octets 0-255, ou null si la forme ne convient pas.
function parseIpv4Octets(
  value: string,
): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

// Découpe une IPv6 en 8 groupes de 16 bits, ou null si invalide. Gère la
// compression « :: » (une seule occurrence). Sert à distinguer :: (wildcard,
// refusé) de ::1 (loopback) et à vérifier le préfixe Tailscale /48.
function parseIpv6Groups(value: string): number[] | null {
  if (!value.includes(":")) return null;
  // Ni zone (%eth0), ni crochets, ni forme mixte IPv4 : hors périmètre.
  if (value.includes("%") || value.includes("[") || value.includes("]")) {
    return null;
  }

  const sides = value.split("::");
  if (sides.length > 2) return null; // « :: » au plus une fois.

  const parseSide = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  if (sides.length === 2) {
    const head = parseSide(sides[0] ?? "");
    const tail = parseSide(sides[1] ?? "");
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // « :: » doit couvrir au moins un groupe.
    return [...head, ...Array<number>(missing).fill(0), ...tail];
  }

  const groups = parseSide(value);
  if (groups === null || groups.length !== 8) return null;
  return groups;
}

// Allowlist stricte de BIND_HOST (règle d'architecture CLAUDE.md, revue
// constat 1) : loopback et plages Tailscale uniquement. Tout le reste —
// 0.0.0.0, :: (wildcard IPv6), IP LAN, nom d'hôte arbitraire — est refusé.
export function isAllowedBindHost(host: string): boolean {
  if (host === "localhost") return true;

  const ipv4 = parseIpv4Octets(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (Tailscale)
    return false;
  }

  const ipv6 = parseIpv6Groups(host);
  if (ipv6) {
    // ::1 (loopback) : les 7 premiers groupes à 0, le dernier à 1.
    if (ipv6.every((group, i) => (i === 7 ? group === 1 : group === 0))) {
      return true;
    }
    // fd7a:115c:a1e0::/48 (Tailscale).
    if (ipv6[0] === 0xfd7a && ipv6[1] === 0x115c && ipv6[2] === 0xa1e0) {
      return true;
    }
    return false;
  }

  return false; // nom d'hôte arbitraire : refusé.
}

// BIND_HOST : défaut 127.0.0.1, restreint à l'allowlist ci-dessus.
function parseBindHost(raw: string | undefined): string {
  const host = raw ?? "127.0.0.1";
  if (!isAllowedBindHost(host)) {
    throw new Error(
      `BIND_HOST « ${host} » n'est pas autorisé. Valeurs acceptées : loopback ` +
        `(127.0.0.0/8, localhost, ::1) ou une adresse Tailscale (100.64.0.0/10, ` +
        `fd7a:115c:a1e0::/48). Jamais 0.0.0.0 ni :: (voir CLAUDE.md).`,
    );
  }
  return host;
}

// ORANGE_GATEWAY_IP : vide → null (auto-détection via `route -n get default`,
// voir network.ts) ; sinon doit ressembler à une IPv4.
function parseOrangeGatewayIp(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!parseIpv4Octets(raw)) {
    throw new Error(
      "ORANGE_GATEWAY_IP doit être une adresse IPv4 (4 octets 0-255), ou vide pour l'auto-détection.",
    );
  }
  return raw;
}

// REMOTE_HOST : troisième sonde réseau, un site distant hors du LAN. Sa
// valeur par défaut est celle qu'observait le déploiement d'origine ; la
// rendre configurable évite qu'une cible durablement muette maintienne
// l'alerte globale allumée en permanence — une alerte qui ne s'éteint jamais
// cesse d'être lue.
//
// IPv4 ou nom d'hôte : la sonde est un ping, les deux conviennent. On refuse
// en revanche tout ce qui ressemble à une URL ou porte un caractère de
// séparation, qui trahirait une confusion avec une adresse de service.
function parseRemoteHost(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "83.204.110.38";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(value) || value.startsWith("-") || value.endsWith("-")) {
    throw new Error(
      "REMOTE_HOST doit être une adresse IPv4 ou un nom d'hôte (sans schéma, port ni chemin).",
    );
  }
  return value;
}

// Chemin de fichier : valeur par défaut si absente, sinon non vide après trim.
function parsePath(
  raw: string | undefined,
  name: string,
  fallback: string,
): string {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(
      `${name} ne doit pas être vide (retirer la variable pour utiliser « ${fallback} »).`,
    );
  }
  return trimmed;
}

// Topic ntfy : mot unique, sans « / » ni « . ». La contrainte est celle de
// ntfy, mais elle sert aussi de garde ici — le topic part dans une requête
// sortante, et un caractère de chemin y aurait sa place pour viser une autre
// route du serveur.
const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// NTFY_URL : URL du SERVEUR seule (le topic voyage à part). Refuse tout ce qui
// n'a rien à faire là : identifiants dans l'URL — qui fuiraient dans le
// moindre message d'erreur — paramètres et ancre.
function parseNtfyUrl(raw: string): string {
  const url = new URL(parseHttpUrl("NTFY_URL", raw));
  if (url.username || url.password) {
    throw new Error(
      "NTFY_URL ne doit pas contenir d'identifiants (https://user:mdp@…) : utiliser NTFY_TOKEN.",
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      "NTFY_URL ne doit porter ni paramètre de requête ni ancre : seulement le serveur (ex. https://ntfy.sh/).",
    );
  }
  // Toujours terminée par « / » : la publication se fait sur la racine du
  // serveur, en JSON (voir relayToNtfy dans notify.ts).
  return url.pathname.endsWith("/") ? url.href : `${url.href}/`;
}

// NTFY_URL / NTFY_TOPIC / NTFY_TOKEN : le relais push est OPTIONNEL et son
// absence est un état légitime, rapporté tel quel par /api/notify (« relais non
// configuré »). En revanche une configuration À MOITIÉ remplie est une erreur
// de démarrage : elle produirait un relais qui échoue à chaque notification
// sans que personne ne sache pourquoi — exactement l'échec silencieux que la
// phase 3 doit exclure.
function parseNtfy(source: EnvSource): NtfyConfig | null {
  const url = source.NTFY_URL?.trim() ?? "";
  const topic = source.NTFY_TOPIC?.trim() ?? "";
  const token = source.NTFY_TOKEN?.trim() ?? "";

  if (!url && !topic) {
    if (token) {
      throw new Error(
        "NTFY_TOKEN est défini sans NTFY_URL ni NTFY_TOPIC : compléter la configuration du relais ou retirer la variable.",
      );
    }
    return null;
  }
  if (!url || !topic) {
    throw new Error(
      `Relais ntfy incomplet : ${url ? "NTFY_TOPIC" : "NTFY_URL"} manque (renseigner les deux, ou aucune des deux pour désactiver le relais).`,
    );
  }
  if (!NTFY_TOPIC_PATTERN.test(topic)) {
    throw new Error(
      "NTFY_TOPIC doit être un nom de topic simple : lettres, chiffres, « - » ou « _ », 64 caractères au plus.",
    );
  }
  if (token === "change-me") {
    throw new Error(
      "NTFY_TOKEN a gardé la valeur d'exemple « change-me » : renseigner un jeton d'accès ntfy, ou retirer la variable pour un topic public.",
    );
  }
  return { url: parseNtfyUrl(url), topic, token: token || null };
}

// Valide une source d'environnement complète et renvoie l'objet de config.
// Pure (n'accède pas à process.env) pour rester testable — voir env.test.ts.
export function parseEnv(source: EnvSource) {
  const gatewayUrl = parseHttpUrl(
    "GATEWAY_URL",
    requiredFrom(source, "GATEWAY_URL"),
  );
  return {
    port: parsePort(source.PORT),
    bindHost: parseBindHost(source.BIND_HOST),
    authToken: parseAuthToken(source),
    gatewayUrl,
    // WS de la gateway OpenClaw (chat) : même host/port que GATEWAY_URL, en ws://.
    gatewayWsUrl: gatewayUrl.replace(/^http/, "ws").replace(/\/?$/, "/"),
    // Token partagé de la gateway (gateway.auth.token dans ~/.openclaw/openclaw.json),
    // distinct de notre propre AUTH_TOKEN.
    gatewayAuthToken: parseGatewayAuthToken(source),
    ollamaUrl: parseHttpUrl(
      "OLLAMA_URL",
      source.OLLAMA_URL ?? "http://127.0.0.1:11434",
    ),
    ollamaFallbackModel: source.OLLAMA_FALLBACK_MODEL ?? "qwen3.5:9b",
    // Si vide, auto-détectée via `route -n get default` (voir network.ts).
    orangeGatewayIp: parseOrangeGatewayIp(source.ORANGE_GATEWAY_IP),
    remoteHost: parseRemoteHost(source.REMOTE_HOST),
    // null = relais push désactivé (voir parseNtfy) ; /api/notify le rapporte
    // alors comme « non configuré », jamais comme une panne.
    ntfy: parseNtfy(source),
    dbPath: parsePath(source.DB_PATH, "DB_PATH", "./data/clawdeck.sqlite"),
    gatewayDeviceIdentityPath: parsePath(
      source.GATEWAY_DEVICE_IDENTITY_PATH,
      "GATEWAY_DEVICE_IDENTITY_PATH",
      "./data/gateway-device-identity.json",
    ),
  };
}

// Configuration du process, résolue au PREMIER ACCÈS et non à l'import.
//
// L'ancienne forme (`export const env = parseEnv(process.env)`) faisait échouer
// le simple chargement de ce module quand la configuration manquait. Effet
// concret : `bun test src/env.test.ts` était impossible à lancer seul hors
// d'un dossier contenant un `.env`, alors que ce fichier ne teste QUE des
// fonctions pures. La suite complète, elle, ne passait que parce qu'un autre
// fichier de test amorçait `process.env` avant — un ordre d'exécution dont
// dépendait silencieusement la CI.
export type Env = ReturnType<typeof parseEnv>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  return (cachedEnv ??= parseEnv(process.env));
}

// Réservé aux tests : impose une configuration sans passer par process.env.
export function useEnv(next: Env | null): void {
  cachedEnv = next;
}
