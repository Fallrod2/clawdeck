// src/hooks/useLogStream.ts — tail SSE /api/logs via fetch + ReadableStream
// (EventSource ne permet pas le header Authorization). Reconnexion en backoff
// exponentiel 1 s → 30 s, remis à zéro dès qu'une frame arrive, relance
// immédiate au retour en ligne ou de visibilité. Un 401 arrête le flux
// (état « auth »), sans nouvelle tentative automatique.

import { useCallback, useEffect, useState } from "react";

export interface LogEntry {
  id: string;
  timestamp: string | null;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  subsystem: string | null;
  message: string;
}

export type LogStreamState = "paused" | "connecting" | "open" | "auth" | "error";

interface LogsPayload {
  entries?: LogEntry[];
  reset?: boolean;
  truncated?: boolean;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let waitingRetry = false;
    let attempts = 0;
    let controller: AbortController | null = null;

    function scheduleReconnect() {
      if (cancelled) return;
      const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
      attempts += 1;
      waitingRetry = true;
      retryTimer = setTimeout(() => {
        waitingRetry = false;
        void connect();
      }, delayMs);
    }

    // Relance immédiate uniquement si on attendait un délai de backoff :
    // on ne double jamais une connexion déjà en cours.
    function reconnectNow() {
      if (cancelled || !waitingRetry) return;
      if (retryTimer != null) clearTimeout(retryTimer);
      waitingRetry = false;
      void connect();
    }

    const onOnline = () => reconnectNow();
    const onVisibilityChange = () => {
      if (!document.hidden) reconnectNow();
    };

    async function connect() {
      controller = new AbortController();
      setState("connecting");
      let shouldRetry = true;
      try {
        const response = await fetch("/api/logs", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (response.status === 401) {
          // Token rejeté : on s'arrête là, sans retry ni « HTTP 401 » brut.
          shouldRetry = false;
          setError(null);
          setState("auth");
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        setState("open");
        setError(null);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) {
            // Fin propre côté serveur : état honnête pendant la reconnexion.
            if (!cancelled) setState("connecting");
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          if (events.length > 0) attempts = 0; // frame reçue : backoff remis à zéro

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
              // Un reset repart d'une vue propre : le drapeau « tail tronqué »
              // ne doit pas coller à l'écran après lui.
              setTruncated((current) =>
                payload.reset ? payload.truncated === true : current || payload.truncated === true,
              );
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

      if (!cancelled && shouldRetry) scheduleReconnect();
    }

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void connect();

    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer != null) clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [token, active]);

  const clear = useCallback(() => {
    setEntries([]);
    setTruncated(false);
  }, []);

  return { entries, state, error, truncated, clear };
}
