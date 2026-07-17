// src/components/FreshnessBadge.tsx — âge d'une mesure (« il y a 12 s »),
// recalculé chaque seconde. Ton neutre quand la mesure est fraîche, alerte
// au-delà de staleAfterMs, périmé au-delà de deadAfterMs. Toujours libellé +
// symbole + couleur (UI_UX §4), sans bruit lecteur d'écran (aria-live off).

import { DEAD_AFTER_MS, STALE_AFTER_MS, formatRelativeAgeFr, useNow } from "../hooks/useNow";

export function FreshnessBadge({
  timestamp,
  staleAfterMs = STALE_AFTER_MS,
  deadAfterMs = DEAD_AFTER_MS,
  className = "",
}: {
  /** Timestamp (ms epoch) de la dernière mesure, ou null si aucune. */
  timestamp: number | null;
  staleAfterMs?: number;
  deadAfterMs?: number;
  className?: string;
}) {
  const now = useNow(1_000);

  if (timestamp == null) {
    return (
      <span
        aria-live="off"
        className={`inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-[var(--text-muted)] ${className}`}
      >
        <span aria-hidden>…</span>
        aucune mesure
      </span>
    );
  }

  const ageMs = Math.max(0, now - timestamp);
  const level = ageMs > deadAfterMs ? "dead" : ageMs > staleAfterMs ? "stale" : "fresh";
  const ageText = formatRelativeAgeFr(ageMs);
  const toneClass =
    level === "dead" ? "text-red-300" : level === "stale" ? "text-amber-300" : "text-[var(--text-muted)]";

  return (
    <span
      aria-live="off"
      title={`Dernière mesure à ${new Date(timestamp).toLocaleTimeString("fr-FR")}`}
      className={`inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums ${toneClass} ${className}`}
    >
      {level === "fresh" ? (
        <span className="h-1 w-1 shrink-0 rounded-full bg-current opacity-70" aria-hidden />
      ) : (
        <span aria-hidden>!</span>
      )}
      {level === "dead" ? `périmé · ${ageText}` : ageText}
    </span>
  );
}
