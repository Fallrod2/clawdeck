// src/status-collector.ts — boucle de collecte unique, indépendante des clients.

export type StatusListener<T> = (snapshot: T) => void;

export interface StatusCollectorOptions {
  intervalMs: number;
  onError?: (error: Error) => void;
}

export class StatusCollector<T> {
  private latest: T | null = null;
  private listeners = new Set<StatusListener<T>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  constructor(
    private readonly collect: () => Promise<T>,
    private readonly options: StatusCollectorOptions,
  ) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("StatusCollector intervalMs must be a positive number");
    }
  }

  get current(): T | null {
    return this.latest;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.beginCycle();
  }

  refresh(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.beginCycle();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  subscribe(listener: StatusListener<T>): () => void {
    this.listeners.add(listener);
    if (this.latest !== null) {
      try {
        listener(this.latest);
      } catch (error) {
        this.reportError(error);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private beginCycle(): void {
    if (!this.running || this.inFlight) return;
    const startedAt = Date.now();
    const cycle = this.runCycle();
    this.inFlight = cycle;

    void cycle.finally(() => {
      if (this.inFlight === cycle) this.inFlight = null;
      if (!this.running) return;
      const elapsedMs = Date.now() - startedAt;
      const delayMs = Math.max(0, this.options.intervalMs - elapsedMs);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.beginCycle();
      }, delayMs);
    });
  }

  private async runCycle(): Promise<void> {
    try {
      const snapshot = await this.collect();
      this.latest = snapshot;
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch (error) {
          this.reportError(error);
        }
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
