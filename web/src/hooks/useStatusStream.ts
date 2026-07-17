// src/hooks/useStatusStream.ts — consomme le SSE /api/status.
// On n'utilise pas EventSource nativement : il ne permet pas d'envoyer le header
// Authorization, donc on lit le flux via fetch + ReadableStream à la main.
// Reconnexion : backoff exponentiel 1 s → 30 s, remis à zéro dès qu'une frame
// arrive, relance immédiate au retour en ligne ou quand l'onglet redevient
// visible. Un 401 arrête définitivement le flux (jusqu'à un nouveau token).

import { useEffect, useRef, useState } from "react";
import type { StatusPayload } from "../lib/types";

export type ConnectionState = "connecting" | "open" | "unauthorized" | "error";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function useStatusStream(token: string | null) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [rejectedToken, setRejectedToken] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let waitingRetry = false;
    let attempts = 0;
    setRejectedToken(null);

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
      const controller = new AbortController();
      abortRef.current = controller;
      setState("connecting");
      let shouldRetry = true;

      try {
        const res = await fetch("/api/status", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (res.status === 401) {
          shouldRetry = false;
          setRejectedToken(token);
          setState("unauthorized");
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setState("open");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) {
            // Fin propre côté serveur : on repasse tout de suite en
            // reconnexion, pas de « open » fantôme pendant le délai.
            if (!cancelled) setState("connecting");
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          if (events.length > 0) attempts = 0; // frame reçue : backoff remis à zéro

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

      if (!cancelled && shouldRetry) scheduleReconnect();
    }

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void connect();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (retryTimer != null) clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [token]);

  return { status, state, rejectedToken };
}
