// src/logs.ts — réduction des lignes JSONL OpenClaw à des champs sûrs pour l'UI.

import type { GatewayLogTailResult } from "./gateway/client";

export interface DashboardLogEntry {
  id: string;
  timestamp: string | null;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  subsystem: string | null;
  message: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function parseSubsystem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = record(JSON.parse(value));
    const subsystem = parsed?.subsystem;
    return typeof subsystem === "string" && subsystem.trim() ? subsystem.trim() : null;
  } catch {
    return value.startsWith("{") ? null : value.trim();
  }
}

function normalizeLevel(value: unknown): DashboardLogEntry["level"] {
  const level = typeof value === "string" ? value.toLowerCase() : "info";
  if (["trace", "debug", "info", "warn", "error", "fatal"].includes(level)) {
    return level as DashboardLogEntry["level"];
  }
  return "info";
}

export function normalizeLogTail(result: GatewayLogTailResult): DashboardLogEntry[] {
  return result.lines.flatMap((line, index) => {
    try {
      const parsed = record(JSON.parse(line));
      if (!parsed) return [];
      const meta = record(parsed._meta);
      const message = typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed["1"] === "string"
          ? parsed["1"]
          : typeof parsed["0"] === "string"
            ? parsed["0"]
            : "Log OpenClaw";
      const timestamp = typeof parsed.time === "string"
        ? parsed.time
        : typeof meta?.date === "string"
          ? meta.date
          : null;
      const subsystem =
        parseSubsystem(meta?.name) ??
        parseSubsystem(parsed["0"]);

      return [{
        id: `${result.cursor}-${index}`,
        timestamp,
        level: normalizeLevel(meta?.logLevelName ?? parsed.level),
        subsystem,
        message: message.slice(0, 4_000),
      }];
    } catch {
      return [{
        id: `${result.cursor}-${index}`,
        timestamp: null,
        level: "info" as const,
        subsystem: null,
        message: line.slice(0, 4_000),
      }];
    }
  });
}
