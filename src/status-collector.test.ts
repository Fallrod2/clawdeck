import { describe, expect, test } from "bun:test";
import { StatusCollector } from "./status-collector";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await Bun.sleep(5);
  }
}

describe("StatusCollector", () => {
  test("collects immediately without subscribers", async () => {
    let calls = 0;
    const collector = new StatusCollector(async () => ({ sequence: ++calls }), {
      intervalMs: 1_000,
    });

    collector.start();
    await waitFor(() => collector.current !== null);

    expect(collector.current).toEqual({ sequence: 1 });
    expect(calls).toBe(1);
    await collector.stop();
  });

  test("keeps collecting while no subscriber is connected", async () => {
    let calls = 0;
    const collector = new StatusCollector(async () => ++calls, {
      intervalMs: 10,
    });

    collector.start();
    await waitFor(() => calls >= 3);
    await collector.stop();

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(collector.current).toBe(calls);
  });

  test("shares one collection loop across every subscriber", async () => {
    let calls = 0;
    const collector = new StatusCollector(async () => ++calls, {
      intervalMs: 1_000,
    });
    collector.start();
    await waitFor(() => collector.current !== null);

    const first: number[] = [];
    const second: number[] = [];
    const unsubscribeFirst = collector.subscribe((value) => first.push(value));
    const unsubscribeSecond = collector.subscribe((value) => second.push(value));

    expect(first).toEqual([1]);
    expect(second).toEqual([1]);
    expect(calls).toBe(1);

    unsubscribeFirst();
    unsubscribeSecond();
    await collector.stop();
  });

  test("never overlaps slow collection cycles", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const collector = new StatusCollector(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(25);
      active -= 1;
      return calls;
    }, { intervalMs: 10 });

    collector.start();
    await waitFor(() => calls >= 3);
    await collector.stop();

    expect(maxActive).toBe(1);
  });

  test("reports a failure and recovers on the next cycle", async () => {
    let calls = 0;
    const errors: string[] = [];
    const collector = new StatusCollector(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return { ok: true };
    }, {
      intervalMs: 10,
      onError: (error) => errors.push(error.message),
    });

    collector.start();
    await waitFor(() => collector.current !== null);
    await collector.stop();

    expect(errors).toEqual(["temporary failure"]);
    expect(collector.current).toEqual({ ok: true });
  });

  test("met en file un refresh reçu pendant un cycle en cours", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | null = null;
    const collector = new StatusCollector(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return calls;
    }, { intervalMs: 10_000 });

    collector.start();
    await waitFor(() => releaseFirst !== null);

    // Refresh pendant le premier cycle : il ne doit pas être perdu.
    collector.refresh();
    releaseFirst!();

    await waitFor(() => calls >= 2);
    expect(calls).toBe(2);
    await collector.stop();
  });
});
