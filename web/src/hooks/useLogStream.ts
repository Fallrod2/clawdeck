import { useCallback, useEffect, useState } from "react";

export interface LogEntry {
  id: string;
  timestamp: string | null;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  subsystem: string | null;
  message: string;
}

type LogStreamState = "paused" | "connecting" | "open" | "error";

interface LogsPayload {
  entries?: LogEntry[];
  reset?: boolean;
  truncated?: boolean;
}

export function useLogStream(token: string | null, active: boolean) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [state, setState] = useState<LogStreamState>(active ? "connecting" : "paused");
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!token || !active) {
      setState("paused");
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;

    async function connect() {
      controller = new AbortController();
      setState("connecting");
      try {
        const response = await fetch("/api/logs", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        setState("open");
        setError(null);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const rawEvent of events) {
            const lines = rawEvent.split("\n");
            const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
            const data = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
            if (!data) continue;
            try {
              const payload = JSON.parse(data) as LogsPayload & { message?: string };
              if (event === "error") {
                setError(payload.message ?? "Flux de logs indisponible");
                continue;
              }
              if (event !== "logs") continue;
              const incoming = Array.isArray(payload.entries) ? payload.entries : [];
              setTruncated((current) => current || payload.truncated === true);
              setEntries((current) => {
                const base = payload.reset ? [] : current;
                const seen = new Set(base.map((entry) => entry.id));
                const merged = [...base, ...incoming.filter((entry) => !seen.has(entry.id))];
                return merged.slice(-500);
              });
            } catch {
              // Une frame malformée ne doit pas interrompre les suivantes.
            }
          }
        }
      } catch (reason) {
        if (cancelled) return;
        setState("error");
        setError(reason instanceof Error ? reason.message : "Flux de logs indisponible");
      }

      if (!cancelled) retryTimer = setTimeout(connect, 3_000);
    }

    void connect();
    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(retryTimer);
    };
  }, [token, active]);

  const clear = useCallback(() => {
    setEntries([]);
    setTruncated(false);
  }, []);

  return { entries, state, error, truncated, clear };
}
