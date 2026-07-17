// src/components/StatusCard.tsx — état d'un service lisible au premier regard.
// Le statut est toujours communiqué par un symbole, un libellé et une couleur.

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
}: {
  title: string;
  code: string;
  tone: Tone;
  latencyMs?: number | null;
  detail?: string;
  metricLabel?: string;
  metricValue?: string | null;
}) {
  const style = TONE_STYLES[tone];

  return (
    <article
      className="group flex min-h-40 flex-col rounded-xl border border-white/8 bg-[var(--surface-panel)] p-4 transition-colors hover:border-white/14"
      aria-label={`${title} : ${style.label}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`flex h-9 min-w-9 items-center justify-center rounded-lg ${style.surface} px-2 font-mono text-[11px] font-semibold tracking-wide ${style.text}`}>
          {code}
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/8 bg-black/15 px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: style.dot }}
            aria-hidden
          />
          {style.label}
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
