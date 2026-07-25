// src/network.ts — ping ICMP via le binaire macOS et détection de la
// passerelle par défaut du réseau local.

const DEFAULT_PING_TIMEOUT_MS = 2_000;

export interface PingResult {
  ok: boolean;
  latencyMs: number | null;
}

interface PingProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

type CommandSpawn = (command: string[]) => PingProcess;

export interface PingOptions {
  timeoutMs?: number;
  spawn?: CommandSpawn;
}

function spawnCommand(command: string[]): PingProcess {
  return Bun.spawn({
    cmd: command,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // On vide le flux sans conserver son contenu en mémoire.
  }
}

export async function ping(host: string, options: PingOptions = {}): Promise<PingResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ping timeoutMs must be a positive number");
  }

  try {
    // Sur le macOS actuel : -t borne la durée globale en secondes et -W borne
    // l'attente d'une réponse en millisecondes. Le timer Bun reste le garde-fou
    // final si le binaire ou le sous-processus se bloque.
    const command = [
      "ping",
      "-c",
      "1",
      "-t",
      String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
      "-W",
      String(Math.ceil(timeoutMs)),
      host,
    ];
    const proc = (options.spawn ?? spawnCommand)(command);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // Le processus peut s'être terminé entre le timeout et kill().
      }
    }, timeoutMs);

    try {
      const [output, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        drain(proc.stderr),
        proc.exited,
      ]);
      if (timedOut || exitCode !== 0) return { ok: false, latencyMs: null };

      const match = output.match(/time[=<]([\d.]+)\s*ms/);
      return { ok: true, latencyMs: match?.[1] ? parseFloat(match[1]) : null };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, latencyMs: null };
  }
}

// Cache de la passerelle par défaut. Deux invalidations complémentaires, parce
// qu'elles n'attrapent pas les mêmes pannes :
//
// 1. TTL de 60 s — seul filet contre une bascule SILENCIEUSE : la route par
//    défaut change alors que l'ancienne adresse reste pingable (second routeur
//    sur le même LAN, box remplacée dans le même plan d'adressage). Aucun
//    échec ne se produit dans ce cas, seul le temps peut lever le doute. 60 s
//    est le seuil au-delà duquel l'interface déclare déjà une mesure
//    « périmée » (DEAD_AFTER_MS, web/src/hooks/useNow.ts) : la détection qui
//    la sous-tend n'a aucune raison d'être plus ancienne que ça. Coût réel :
//    une commande `route` locale toutes les douze boucles de sonde (5 s),
//    sans le moindre paquet réseau.
//
// 2. Trois échecs consécutifs — la bascule BRUYANTE (Wi-Fi vers partage 4G,
//    changement de sous-réseau) rend l'ancienne adresse injoignable dans la
//    seconde ; attendre le TTL laisserait jusqu'à une minute d'affichage faux.
//    Un échec isolé ne prouve rien, un écho ICMP perdu est banal ; trois
//    échecs à 5 s d'intervalle valent ~15 s de confirmation, soit le moment où
//    l'interface cesse elle-même de tenir la mesure pour fraîche
//    (STALE_AFTER_MS). Re-détecter est idempotent : si la route n'a pas bougé,
//    `route` rend la même adresse et rien ne change à l'écran.
//
// Un ping RÉUSSI remet le compteur d'échecs à zéro mais ne prolonge jamais le
// TTL : une passerelle joignable qui n'est plus la route par défaut est
// exactement le cas que le TTL existe pour rattraper.
const GATEWAY_CACHE_TTL_MS = 60_000;
const GATEWAY_FAILURE_LIMIT = 3;

interface GatewayCache {
  ip: string;
  detectedAt: number;
  consecutiveFailures: number;
}

let gatewayCache: GatewayCache | null = null;

// Points d'injection réservés aux tests (commande factice, horloge et TTL
// contrôlés) ; en production les valeurs par défaut s'appliquent.
export interface DetectGatewayOptions {
  spawn?: CommandSpawn;
  now?: () => number;
  ttlMs?: number;
}

/** Détecte l'IP de la passerelle par défaut (ex: la Livebox Orange). */
export async function detectDefaultGateway(
  options: DetectGatewayOptions = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GATEWAY_CACHE_TTL_MS;
  const cached = gatewayCache;
  if (cached && now() - cached.detectedAt < ttlMs) return cached.ip;

  try {
    const proc = (options.spawn ?? spawnCommand)(["route", "-n", "get", "default"]);
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      drain(proc.stderr),
      proc.exited,
    ]);
    const match = output.match(/gateway:\s*([\d.]+)/);
    if (match?.[1]) {
      // Toute détection aboutie ouvre une nouvelle fenêtre de confiance, même
      // si l'adresse est inchangée : sans cette remise à zéro du compteur, une
      // panne locale durable relancerait `route` à chaque boucle de sonde.
      gatewayCache = { ip: match[1], detectedAt: now(), consecutiveFailures: 0 };
      return match[1];
    }
  } catch {
    // Ignoré : traité comme une détection sans réponse, juste en dessous.
  }

  // Détection muette (pas de route par défaut, commande en échec). On rend la
  // dernière adresse connue sans rafraîchir sa date : elle reste la cible la
  // plus plausible, et le TTL expiré fait retenter la détection à chaque
  // boucle jusqu'à ce que `route` réponde de nouveau. Lui substituer un
  // repli codé en dur sonderait une adresse que rien n'a jamais observée.
  return cached?.ip ?? null;
}

/**
 * Retour de sonde sur l'adresse détectée : c'est ce qui déclenche
 * l'invalidation après échecs répétés (voir le commentaire du cache).
 * Un retour portant sur une autre adresse — ORANGE_GATEWAY_IP forcé dans
 * `.env`, repli codé en dur — est ignoré : il ne dit rien de la détection.
 */
export function reportDefaultGatewayProbe(host: string, ok: boolean): void {
  const cached = gatewayCache;
  if (!cached || cached.ip !== host) return;
  if (ok) {
    cached.consecutiveFailures = 0;
    return;
  }
  cached.consecutiveFailures += 1;
  if (cached.consecutiveFailures >= GATEWAY_FAILURE_LIMIT) {
    // On périme la détection sans jeter l'adresse : la prochaine boucle
    // relancera `route`, et s'il reste muet (lien coupé, plus de route par
    // défaut) la dernière adresse observée sur ce réseau est une cible plus
    // honnête qu'un repli codé en dur — c'est elle que l'opérateur verra
    // nommée dans le diagnostic.
    cached.detectedAt = Number.NEGATIVE_INFINITY;
    cached.consecutiveFailures = 0;
  }
}

/** Réservé aux tests : repart d'un cache vide entre deux scénarios. */
export function resetDefaultGatewayCache(): void {
  gatewayCache = null;
}
