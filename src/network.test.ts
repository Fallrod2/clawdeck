import { describe, expect, test } from "bun:test";
import { ping, type PingOptions } from "./network";

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
