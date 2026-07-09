// src/hooks/useStatusStream.ts — consomme le SSE /api/status.
// On n'utilise pas EventSource nativement : il ne permet pas d'envoyer le header
// Authorization, donc on lit le flux via fetch + ReadableStream à la main.

import { useEffect, useRef, useState } from "react";
import type { StatusPayload } from "../lib/types";

export type ConnectionState = "connecting" | "open" | "error";

export function useStatusStream(token: string | null) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    async function connect() {
      const controller = new AbortController();
      abortRef.current = controller;
      setState("connecting");

      try {
        const res = await fetch("/api/status", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setState("open");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            const dataLine = evt.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(5).trim()) as StatusPayload;
              if (!cancelled) setStatus(payload);
            } catch {
              // ligne malformée : on ignore, le prochain tick corrigera l'affichage
            }
          }
        }
      } catch {
        if (cancelled) return;
        setState("error");
      }

      if (!cancelled) retryTimer = setTimeout(connect, 3000);
    }

    connect();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      clearTimeout(retryTimer);
    };
  }, [token]);

  return { status, state };
}
