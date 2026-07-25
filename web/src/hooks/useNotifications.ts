// src/hooks/useNotifications.ts — flux SSE des notifications (phase 3).
//
// Même motif que useStatusStream : EventSource n'accepte pas d'en-tête, donc
// `fetch` + lecture du corps en flux, avec backoff borné et relance à la
// reprise de visibilité ou de réseau.
//
// AUCUN historique n'est conservé, ni ici ni côté serveur : c'est une règle
// d'architecture du projet (rien de ce qui vient d'OpenClaw n'est persisté).
// Une notification manquée est manquée — le dashboard n'est pas une boîte de
// réception, et prétendre le contraire obligerait à stocker ce qu'on refuse
// de stocker.

import { useCallback, useEffect, useRef, useState } from "react";

export type NotificationSeverity = "info" | "warning" | "error";

export interface DashboardNotification {
  id: string;
  at: number;
  title: string;
  message: string;
  severity: NotificationSeverity;
  tags: string[];
}

// Plafond d'affichage simultané. Au-delà, les plus anciennes sortent : un
// empilement illimité masquerait l'interface qu'il est censé annoter.
const MAX_VISIBLE = 4;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseNotification(raw: unknown): DashboardNotification | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  if (n.type !== "notification") return null;
  const title = asString(n.title);
  const message = asString(n.message);
  if (!title || !message) return null;
  const severity =
    n.severity === "warning" || n.severity === "error" ? n.severity : "info";
  return {
    id: asString(n.id) ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    at: typeof n.at === "number" ? n.at : Date.now(),
    title,
    message,
    severity,
    tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

export function useNotifications(token: string | null) {
  const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
  // Nombre d'événements perdus par saturation côté serveur : le taire
  // laisserait croire qu'on a tout vu.
  const [dropped, setDropped] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearDropped = useCallback(() => setDropped(0), []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleReconnect() {
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
      attempts += 1;
      clearTimeout(timer);
      timer = setTimeout(connect, delay);
    }

    function handleFrame(payload: unknown) {
      const record = payload as Record<string, unknown> | null;
      if (record?.type === "notifications-dropped") {
        const count = typeof record.count === "number" ? record.count : 0;
        if (count > 0) setDropped((previous) => previous + count);
        return;
      }
      const notification = parseNotification(payload);
      if (!notification) return;
      setNotifications((prev) => {
        // Rejeu d'idempotence côté serveur : le même id peut arriver deux fois.
        if (prev.some((n) => n.id === notification.id)) return prev;
        return [...prev, notification].slice(-MAX_VISIBLE);
      });
    }

    async function connect() {
      if (cancelled) return;
      const controller = new AbortController();
      abortRef.current = controller;
      let shouldRetry = true;

      try {
        const res = await fetch("/api/notifications", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        // 401 : état d'auth définitif pour ce token. La purge du token est
        // gérée par useStatusStream et useChat ; ici on se contente de ne pas
        // marteler le serveur.
        if (res.status === 401) {
          shouldRetry = false;
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          if (events.length > 0) attempts = 0;

          for (const evt of events) {
            const dataLine = evt.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue; // commentaire de maintien de connexion
            try {
              handleFrame(JSON.parse(dataLine.slice(5).trim()));
            } catch {
              // frame malformée : ignorée, la suivante corrigera
            }
          }
        }
      } catch {
        // coupure réseau ou abandon : la reconnexion s'en charge
      }

      // Garde d'identité : `retryNow` abandonne la requête en cours PUIS
      // rappelle connect() immédiatement. Sans cette comparaison, la sortie
      // en erreur de la connexion abandonnée programmerait une reconnexion
      // supplémentaire — deux flux ouverts en parallèle à chaque retour de
      // visibilité ou de réseau.
      if (abortRef.current !== controller) return;
      if (!cancelled && shouldRetry) scheduleReconnect();
    }

    const retryNow = () => {
      if (cancelled) return;
      clearTimeout(timer);
      abortRef.current?.abort();
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onVisibility);

    connect();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      abortRef.current?.abort();
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token]);

  return { notifications, dropped, dismiss, clearDropped };
}
