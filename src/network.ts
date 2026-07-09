// src/network.ts — ping ICMP via le binaire système et détection de la
// passerelle par défaut du réseau local (la box Orange).
//
// Bun n'expose pas de socket ICMP brut sans privilèges root ; on délègue
// donc au binaire `ping` du système (macOS), plus simple et fiable.

const PING_TIMEOUT_S = 2;

export interface PingResult {
  ok: boolean;
  latencyMs: number | null;
}

export async function ping(host: string): Promise<PingResult> {
  try {
    const proc = Bun.spawn({
      cmd: ["ping", "-c", "1", "-t", String(PING_TIMEOUT_S), host],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { ok: false, latencyMs: null };

    const match = output.match(/time[=<]([\d.]+)\s*ms/);
    return { ok: true, latencyMs: match?.[1] ? parseFloat(match[1]) : null };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

let cachedGateway: string | null = null;

/** Détecte l'IP de la passerelle par défaut (ex: la Livebox Orange). */
export async function detectDefaultGateway(): Promise<string | null> {
  if (cachedGateway) return cachedGateway;
  try {
    const proc = Bun.spawn({
      cmd: ["route", "-n", "get", "default"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const match = output.match(/gateway:\s*([\d.]+)/);
    if (match?.[1]) {
      cachedGateway = match[1];
      return cachedGateway;
    }
  } catch {
    // Ignoré : l'appelant retombe sur ORANGE_GATEWAY_IP ou un défaut.
  }
  return null;
}
