// src/hooks/usePingHistory.ts — historique bucketé pour le graphe de latence.
// Rafraîchi périodiquement (30s) : la granularité fine (5s) vient déjà du SSE
// pour les cartes de statut, le graphe n'a pas besoin de la même fraîcheur.
// La requête en vol est annulée au changement de période ou de token (une
// réponse obsolète n'est jamais appliquée) et le cycle s'arrête sur 401.

import { useEffect, useState } from "react";
import type { PingHistory } from "../lib/types";

const REFRESH_MS = 30_000;

export function usePingHistory(token: string | null, hours: number) {
  const [history, setHistory] = useState<PingHistory | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    setHistory(null);
    setLastUpdatedAt(null);
    setUnauthorized(false);
    if (!token) return;

    let disposed = false;
    let inFlight: AbortController | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const load = async () => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      try {
        const res = await fetch(`/api/pings/history?hours=${hours}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (disposed || controller.signal.aborted) return;
        if (res.status === 401) {
          // Pas de spam silencieux : on coupe le cycle jusqu'au prochain token.
          setUnauthorized(true);
          stopPolling();
          return;
        }
        if (!res.ok) return;
        const payload = (await res.json()) as PingHistory;
        if (disposed || controller.signal.aborted) return;
        setHistory(payload);
        setLastUpdatedAt(Date.now());
      } catch {
        // abort volontaire ou erreur réseau : le prochain cycle réessaiera
      }
    };

    void load();
    intervalId = setInterval(() => void load(), REFRESH_MS);

    return () => {
      disposed = true;
      inFlight?.abort();
      stopPolling();
    };
  }, [token, hours]);

  return { history, lastUpdatedAt, unauthorized };
}
