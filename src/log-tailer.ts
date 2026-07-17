// src/log-tailer.ts — une seule lecture incrémentale des logs OpenClaw pour
// tous les clients connectés. Aucun log n'est persisté par clawdeck.

import type { GatewayLogTailResult } from "./gateway/client";

export type LogTailEvent =
  | { type: "data"; result: GatewayLogTailResult }
  | { type: "error"; message: string };

export interface LogTailSource {
  getLogs(cursor?: number): Promise<GatewayLogTailResult>;
}

export class LogTailer {
  private listeners = new Set<(event: LogTailEvent) => void>();
  private cursor: number | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  constructor(
    private readonly source: LogTailSource,
    private readonly intervalMs = 2_000,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("LogTailer intervalMs must be a positive number");
    }
  }

  subscribe(listener: (event: LogTailEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.running) {
      this.cursor = undefined;
      this.running = true;
      this.beginRead();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.pause();
    };
  }

  async stop(): Promise<void> {
    this.listeners.clear();
    this.pause();
    await this.inFlight;
  }

  private pause(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private beginRead(): void {
    if (!this.running || this.inFlight) return;
    const read = this.readOnce();
    this.inFlight = read;
    void read.finally(() => {
      if (this.inFlight === read) this.inFlight = null;
      if (!this.running) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.beginRead();
      }, this.intervalMs);
    });
  }

  private async readOnce(): Promise<void> {
    try {
      const result = await this.source.getLogs(this.cursor);
      this.cursor = result.cursor;
      if (result.lines.length || result.reset || result.truncated) {
        this.emit({ type: "data", result });
      }
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emit(event: LogTailEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Un client défaillant ne doit jamais arrêter le tail global.
      }
    }
  }
}
