// src/components/ActivityStrip.tsx — ce qu'OpenClaw fait MAINTENANT.
//
// Raison d'être : un run déclenché ailleurs (message WhatsApp reçu pendant
// qu'on regarde ailleurs, tâche planifiée) n'a aucune trace visible dans le
// dashboard tant que sa réponse n'est pas écrite. Ce bandeau comble ce trou :
// il montre l'activité en cours, son outil courant et son origine, sans
// attendre le résultat. C'est ce qui distingue une console d'exploitation
// d'une simple fenêtre de chat.

import type { RunActivity } from "../lib/chatTypes";
import { activityLabel, formatElapsed, selectLiveRuns } from "../lib/activity";
import { useNow } from "../hooks/useNow";

export function ActivityStrip({ activity, connected }: { activity: RunActivity[]; connected: boolean }) {
  const now = useNow(1_000);
  const live = selectLiveRuns(activity, now);

  // Hors connexion, aucune activité ne peut être affirmée : l'en-tête du
  // panneau porte déjà l'état de liaison, ce bandeau se tait.
  if (!connected) return null;

  const current = live[0];
  if (!current) {
    return (
      <p
        className="flex min-h-9 items-center gap-2 border-b border-white/8 px-4 text-[11px] text-[var(--text-muted)] sm:px-5"
        aria-live="polite"
      >
        <span aria-hidden>○</span>
        <span>OpenClaw est au repos</span>
      </p>
    );
  }

  const others = live.slice(1);
  const blocked = current.waitingApproval;

  return (
    // La clé remonte le bandeau quand le run de tête change : son animation
    // d'entrée rejoue, signalant un NOUVEAU run plutôt qu'une simple
    // progression de celui en cours.
    <div
      key={current.runId}
      className="clawdeck-enter flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/8 px-4 py-1.5 text-[11px] sm:px-5"
      aria-live="polite"
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          blocked ? "bg-[var(--status-warning)]" : "animate-pulse bg-[var(--status-good)]"
        }`}
        aria-hidden
      />
      <span className={blocked ? "text-[var(--status-warning)]" : "text-[var(--text-secondary)]"}>
        {blocked ? "⏸" : "▸"} OpenClaw {activityLabel(current)}
      </span>
      <span className="font-mono text-[var(--text-muted)]">depuis {formatElapsed(now - current.startedAt)}</span>
      {/* Origine du run : sans elle, impossible de savoir si cette activité
          répond à ce qu'on vient d'écrire ou à un message reçu ailleurs. */}
      <span className="text-[var(--text-muted)]">
        · {current.own ? "votre demande" : "déclenché hors du dashboard"}
      </span>
      {others.length > 0 && (
        <span className="text-[var(--text-muted)]">
          · {others.length} autre{others.length > 1 ? "s" : ""} run{others.length > 1 ? "s" : ""} en cours
        </span>
      )}
    </div>
  );
}
