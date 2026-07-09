// src/hooks/usePingHistory.ts — historique bucketé pour le graphe de latence.
// Rafraîchi périodiquement (30s) : la granularité fine (5s) vient déjà du SSE
// pour les cartes de statut, le graphe n'a pas besoin de la même fraîcheur.

import { useCallback, useEffect, useState } from "react";
import type { PingHistory } from "../lib/types";

const REFRESH_MS = 30_000;

export function usePingHistory(token: string | null, hours: number) {
  const [history, setHistory] = useState<PingHistory | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/pings/history?hours=${hours}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setHistory((await res.json()) as PingHistory);
    } catch {
      // le prochain cycle réessaiera
    }
  }, [token, hours]);

  useEffect(() => {
    setHistory(null);
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { history, refresh };
}
