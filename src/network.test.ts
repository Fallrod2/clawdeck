import { beforeEach, describe, expect, test } from "bun:test";
import {
  detectDefaultGateway,
  ping,
  reportDefaultGatewayProbe,
  resetDefaultGatewayCache,
  type PingOptions,
} from "./network";

function stream(text = ""): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function completedProcess(stdout: string, exitCode: number) {
  return {
    stdout: stream(stdout),
    stderr: stream(),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

describe("ping", () => {
  test("parses latency and configures both macOS timeouts", async () => {
    let command: string[] = [];
    const spawn: NonNullable<PingOptions["spawn"]> = (nextCommand) => {
      command = nextCommand;
      return completedProcess("64 bytes from 1.1.1.1: time=6.42 ms\n", 0);
    };

    expect(await ping("1.1.1.1", { timeoutMs: 1_500, spawn })).toEqual({
      ok: true,
      latencyMs: 6.42,
    });
    expect(command).toEqual([
      "ping", "-c", "1", "-t", "2", "-W", "1500", "1.1.1.1",
    ]);
  });

  test("returns a failed result for a non-zero exit", async () => {
    const result = await ping("missing.invalid", {
      spawn: () => completedProcess("", 2),
    });
    expect(result).toEqual({ ok: false, latencyMs: null });
  });

  test("kills a process that exceeds the Bun-side deadline", async () => {
    let killed = false;
    let closeStdout: (() => void) | undefined;
    let resolveExit: ((code: number) => void) | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStdout = () => controller.close();
      },
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const result = await ping("192.0.2.1", {
      timeoutMs: 10,
      spawn: () => ({
        stdout,
        stderr: stream(),
        exited,
        kill() {
          killed = true;
          closeStdout?.();
          resolveExit?.(143);
        },
      }),
    });

    expect(killed).toBe(true);
    expect(result).toEqual({ ok: false, latencyMs: null });
  });

  test("rejects an invalid timeout", async () => {
    expect(ping("1.1.1.1", { timeoutMs: 0 })).rejects.toThrow(
      "ping timeoutMs must be a positive number",
    );
  });
});

describe("detectDefaultGateway", () => {
  const TTL_MS = 60_000;
  let clock = 1_000;
  let routeCalls = 0;
  let routeOutput = "gateway: 192.168.1.1\n";

  const now = () => clock;
  const spawn: NonNullable<PingOptions["spawn"]> = () => {
    routeCalls += 1;
    return completedProcess(routeOutput, 0);
  };
  const detect = () => detectDefaultGateway({ spawn, now, ttlMs: TTL_MS });

  beforeEach(() => {
    resetDefaultGatewayCache();
    clock = 1_000;
    routeCalls = 0;
    routeOutput = "gateway: 192.168.1.1\n";
  });

  test("met la détection en cache pendant le TTL", async () => {
    expect(await detect()).toBe("192.168.1.1");
    clock += TTL_MS - 1;
    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(1);
  });

  test("re-détecte après le TTL, même sans aucun échec de sonde", async () => {
    await detect();
    // Bascule silencieuse : l'ancienne adresse répondait encore, seul le temps
    // pouvait révéler que la route par défaut avait changé.
    reportDefaultGatewayProbe("192.168.1.1", true);
    routeOutput = "gateway: 192.168.8.1\n";
    clock += TTL_MS;

    expect(await detect()).toBe("192.168.8.1");
    expect(routeCalls).toBe(2);
  });

  test("un ping réussi ne prolonge pas le TTL", async () => {
    await detect();
    for (let i = 0; i < 12; i += 1) {
      clock += 5_000;
      reportDefaultGatewayProbe("192.168.1.1", true);
    }
    routeOutput = "gateway: 192.168.8.1\n";

    expect(await detect()).toBe("192.168.8.1");
  });

  test("trois échecs consécutifs invalident le cache avant le TTL", async () => {
    await detect();
    routeOutput = "gateway: 192.168.8.1\n";

    reportDefaultGatewayProbe("192.168.1.1", false);
    reportDefaultGatewayProbe("192.168.1.1", false);
    clock += 15_000;
    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(1);

    reportDefaultGatewayProbe("192.168.1.1", false);
    expect(await detect()).toBe("192.168.8.1");
    expect(routeCalls).toBe(2);
  });

  test("un échec isolé entre deux réussites ne compte pas", async () => {
    await detect();
    routeOutput = "gateway: 192.168.8.1\n";

    for (let i = 0; i < 5; i += 1) {
      reportDefaultGatewayProbe("192.168.1.1", false);
      reportDefaultGatewayProbe("192.168.1.1", false);
      reportDefaultGatewayProbe("192.168.1.1", true);
    }
    clock += 15_000;

    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(1);
  });

  test("ignore un retour de sonde portant sur une autre adresse", async () => {
    await detect();
    routeOutput = "gateway: 192.168.8.1\n";

    // Cas d'un ORANGE_GATEWAY_IP forcé dans .env : ses échecs ne disent rien
    // de la détection et ne doivent pas la faire tomber.
    for (let i = 0; i < 5; i += 1) reportDefaultGatewayProbe("10.0.0.1", false);
    clock += 15_000;

    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(1);
  });

  test("une re-détection identique repart sur un compteur d'échecs neuf", async () => {
    await detect();
    for (let i = 0; i < 3; i += 1) reportDefaultGatewayProbe("192.168.1.1", false);

    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(2);

    // Deux échecs de plus ne suffisent pas : le seuil se compte depuis la
    // dernière détection, sinon `route` serait relancé à chaque boucle.
    reportDefaultGatewayProbe("192.168.1.1", false);
    reportDefaultGatewayProbe("192.168.1.1", false);
    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(2);
  });

  test("détection muette : garde la dernière adresse connue et retente", async () => {
    await detect();
    routeOutput = "";
    clock += TTL_MS;

    // Aucune route par défaut (lien coupé) : substituer un repli codé en dur
    // sonderait une adresse que rien n'a jamais observée sur ce réseau.
    expect(await detect()).toBe("192.168.1.1");
    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(3);

    routeOutput = "gateway: 192.168.8.1\n";
    expect(await detect()).toBe("192.168.8.1");
  });

  test("invalidation par échecs + route muette : l'adresse observée survit", async () => {
    await detect();
    routeOutput = "";
    for (let i = 0; i < 3; i += 1) reportDefaultGatewayProbe("192.168.1.1", false);

    // Coupure du lien : plus de route par défaut à lire. Nommer 192.168.1.1
    // reste honnête — c'est ce qu'on sondait —, inventer un repli ne l'est pas.
    expect(await detect()).toBe("192.168.1.1");
    expect(routeCalls).toBe(2);
  });

  test("sans détection antérieure, une détection muette rend null", async () => {
    routeOutput = "";
    expect(await detect()).toBeNull();
  });
});
