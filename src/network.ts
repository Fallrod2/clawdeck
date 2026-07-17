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

type PingSpawn = (command: string[]) => PingProcess;

export interface PingOptions {
  timeoutMs?: number;
  spawn?: PingSpawn;
}

function spawnPing(command: string[]): PingProcess {
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
    const proc = (options.spawn ?? spawnPing)(command);
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
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      drain(proc.stderr),
      proc.exited,
    ]);
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
