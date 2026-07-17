// src/hooks/useNow.ts — module fraîcheur : horloge de rendu, seuils de
// péremption partagés et formatage d'âge en français.
// useNow re-rend le composant à intervalle régulier, en pause quand l'onglet
// est masqué (document.hidden) pour ne pas réveiller un onglet en arrière-plan,
// reprise immédiate (avec remise à l'heure) au retour de visibilité.

import { useEffect, useState } from "react";

/** Seuil au-delà duquel une mesure vieillit (ton alerte). */
export const STALE_AFTER_MS = 15_000;
/** Seuil au-delà duquel une mesure est périmée (ton critique). */
export const DEAD_AFTER_MS = 60_000;

/** Âge relatif en français, arrondi lisible : s < 60 s < min < h < j. */
export function formatRelativeAgeFr(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer != null) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);

  return now;
}
