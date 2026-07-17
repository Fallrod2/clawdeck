// src/components/StatusCard.tsx — état d'un service lisible au premier regard.
// Le statut est toujours communiqué par un symbole, un libellé et une couleur.
// Quand la donnée est périmée (staleTone), le ton est atténué et le badge
// d'âge prend le relais : jamais de vert plein sur une mesure ancienne (UI_UX §4).

import { FreshnessBadge } from "./FreshnessBadge";

export type Tone = "good" | "warning" | "critical" | "unknown";

const TONE_STYLES: Record<
  Tone,
  { dot: string; label: string; text: string; surface: string }
> = {
  good: {
    dot: "var(--status-good)",
    label: "Opérationnel",
    text: "text-emerald-300",
    surface: "bg-emerald-400/8",
  },
  warning: {
    dot: "var(--status-warning)",
    label: "Dégradé",
    text: "text-amber-300",
    surface: "bg-amber-400/8",
  },
  critical: {
    dot: "var(--status-critical)",
    label: "Indisponible",
    text: "text-red-300",
    surface: "bg-red-400/8",
  },
  unknown: {
    dot: "var(--status-unknown)",
    label: "En attente",
    text: "text-[var(--text-secondary)]",
    surface: "bg-white/4",
  },
};

export function StatusCard({
  title,
  code,
  tone,
  latencyMs,
  detail,
  metricLabel,
  metricValue,
  updatedAt,
  staleTone = false,
}: {
  title: string;
  code: string;
  tone: Tone;
  latencyMs?: number | null;
  detail?: string;
  metricLabel?: string;
  metricValue?: string | null;
  /** Timestamp (ms epoch) de la mesure ; affiche un badge d'âge quand fourni. */
  updatedAt?: number | null;
  /** Vrai quand la mesure est périmée : le ton est atténué, jamais plein. */
  staleTone?: boolean;
}) {
  const style = TONE_STYLES[tone];
  const showFreshness = updatedAt !== undefined;

  return (
    <article
      className="group flex min-h-40 flex-col rounded-xl border border-white/8 bg-[var(--surface-panel)] p-4 transition-colors hover:border-white/14"
      aria-label={`${title} : ${style.label}${staleTone ? " (donnée périmée)" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={`flex h-9 min-w-9 items-center justify-center rounded-lg ${style.surface} px-2 font-mono text-[11px] font-semibold tracking-wide ${style.text} ${staleTone ? "opacity-50" : ""}`}
        >
          {code}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div
            className={`flex items-center gap-2 rounded-full border border-white/8 bg-black/15 px-2.5 py-1 text-[11px] text-[var(--text-secondary)] ${staleTone ? "opacity-60" : ""}`}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: style.dot, opacity: staleTone ? 0.4 : undefined }}
              aria-hidden
            />
            {style.label}
          </div>
          {showFreshness && <FreshnessBadge timestamp={updatedAt ?? null} />}
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">{title}</h3>
        <p className="mt-1 min-h-4 truncate text-xs text-[var(--text-muted)]" title={detail}>
          {detail || "Sonde en temps réel"}
        </p>
      </div>

      <div className="mt-auto flex items-end justify-between border-t border-white/6 pt-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {metricLabel ?? "Latence"}
        </span>
        <span className="font-mono text-sm tabular-nums text-[var(--text-secondary)]">
          {metricValue ?? (latencyMs != null ? `${Math.round(latencyMs)} ms` : "—")}
        </span>
      </div>
    </article>
  );
}
