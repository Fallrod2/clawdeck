import { describe, expect, test } from "bun:test";
import { LogTailer } from "./log-tailer";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await Bun.sleep(5);
  }
}

describe("LogTailer", () => {
  test("shares one cursor across subscribers and pauses without listeners", async () => {
    const cursors: Array<number | undefined> = [];
    let nextCursor = 10;
    const tailer = new LogTailer({
      isConnected: true,
      async getLogs(cursor) {
        cursors.push(cursor);
        nextCursor += 1;
        return { cursor: nextCursor, size: nextCursor, lines: ["{}"], truncated: false, reset: false };
      },
    }, 10);
    const first: number[] = [];
    const second: number[] = [];
    const unsubscribeFirst = tailer.subscribe((event) => {
      if (event.type === "data") first.push(event.result.cursor);
    });
    const unsubscribeSecond = tailer.subscribe((event) => {
      if (event.type === "data") second.push(event.result.cursor);
    });

    await waitFor(() => first.length >= 2 && second.length >= 2);
    unsubscribeFirst();
    unsubscribeSecond();
    const readsAfterPause = cursors.length;
    await Bun.sleep(30);
    await tailer.stop();

    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBe(11);
    expect(cursors.length).toBe(readsAfterPause);
    expect(first).toEqual(second);
  });

  test("reports source errors without rejecting the tail loop", async () => {
    let calls = 0;
    const events: string[] = [];
    const tailer = new LogTailer({
      isConnected: true,
      async getLogs() {
        calls += 1;
        if (calls === 1) throw new Error("gateway offline");
        return { cursor: 1, size: 1, lines: ["{}"], truncated: false, reset: false };
      },
    }, 10);
    const unsubscribe = tailer.subscribe((event) => events.push(event.type));

    await waitFor(() => events.includes("data"));
    unsubscribe();
    await tailer.stop();

    expect(events[0]).toBe("error");
    expect(events).toContain("data");
  });

  test("reste silencieux tant que la gateway est déconnectée, sans appeler getLogs", async () => {
    let calls = 0;
    const events: string[] = [];
    const source = {
      isConnected: false,
      async getLogs() {
        calls += 1;
        return { cursor: 7, size: 7, lines: ["{}"], truncated: false, reset: false };
      },
    };
    const tailer = new LogTailer(source, 10);
    const unsubscribe = tailer.subscribe((event) => events.push(event.type));

    // Plusieurs ticks s'écoulent gateway déconnectée : aucune lecture,
    // aucun événement (surtout pas une erreur toutes les 2 s en production).
    await Bun.sleep(50);
    expect(calls).toBe(0);
    expect(events).toEqual([]);

    // À la reconnexion, le poll suivant reprend de lui-même.
    source.isConnected = true;
    await waitFor(() => events.includes("data"));
    unsubscribe();
    await tailer.stop();

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(events).not.toContain("error");
  });

  test("saute silencieusement quand la source n'annonce pas logs.tail", async () => {
    let calls = 0;
    const events: string[] = [];
    const source = {
      isConnected: true,
      supportsLogs: false,
      async getLogs() {
        calls += 1;
        return { cursor: 3, size: 3, lines: ["{}"], truncated: false, reset: false };
      },
    };
    const tailer = new LogTailer(source, 10);
    const unsubscribe = tailer.subscribe((event) => events.push(event.type));

    // Gateway connectée mais logs.tail non annoncé : aucune lecture, aucun
    // événement — surtout pas une erreur répétée à chaque tick.
    await Bun.sleep(50);
    expect(calls).toBe(0);
    expect(events).toEqual([]);

    // Une découverte ultérieure qui annonce logs.tail relance le poll.
    source.supportsLogs = true;
    await waitFor(() => events.includes("data"));
    unsubscribe();
    await tailer.stop();

    expect(events).not.toContain("error");
  });
});
