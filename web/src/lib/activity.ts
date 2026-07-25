// src/lib/activity.ts — logique pure du bandeau d'activité (voir
// components/ActivityStrip.tsx pour le rendu). Séparée pour être testable
// sans DOM : c'est ici que se décide ce qu'on ose affirmer d'un run.

import type { RunActivity } from "./chatTypes";

// Un run dont plus aucun événement n'arrive depuis ce délai est considéré
// perdu (gateway coupée en plein run, événement terminal jamais reçu) : mieux
// vaut ne plus rien affirmer que d'afficher « en cours » indéfiniment.
export const RUN_STALE_AFTER_MS = 90_000;

/** Durée écoulée, arrondie lisible : s < 60 s < min < h. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

/**
 * Runs encore crédibles à l'instant `now`, le plus récemment actif en tête.
 * Le filtrage par péremption est le cœur de l'honnêteté du bandeau.
 */
export function selectLiveRuns(activity: RunActivity[], now: number): RunActivity[] {
  return activity
    .filter((run) => now - run.lastEventAt < RUN_STALE_AFTER_MS)
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
}

/**
 * Libellé de l'action en cours. Le nom d'outil brut d'OpenClaw est conservé
 * (nom technique officiel, UI_UX.md §8) mais préfixé d'un verbe.
 */
export function activityLabel(run: RunActivity): string {
  if (run.waitingApproval) return "attend une autorisation";
  if (!run.tool) return "réfléchit";
  if (run.tool.phase === "result") return `a terminé ${run.tool.name}`;
  return `exécute ${run.tool.name}`;
}
