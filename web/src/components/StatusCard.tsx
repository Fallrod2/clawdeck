// src/components/StatusCard.tsx — carte de statut : icône + libellé, jamais la
// couleur seule (palette status validée, voir skill dataviz).

export type Tone = "good" | "warning" | "critical" | "unknown";

const TONE_STYLES: Record<Tone, { dot: string; label: string }> = {
  good: { dot: "#0ca30c", label: "OK" },
  warning: { dot: "#fab219", label: "Dégradé" },
  critical: { dot: "#d03b3b", label: "Erreur" },
  unknown: { dot: "#898781", label: "En attente…" },
};

export function StatusCard({
  title,
  tone,
  latencyMs,
  detail,
}: {
  title: string;
  tone: Tone;
  latencyMs?: number | null;
  detail?: string;
}) {
  const { dot, label } = TONE_STYLES[tone];
  return (
    <div className="rounded-lg border border-white/10 bg-neutral-900 p-4">
      <div className="text-sm text-neutral-400">{title}</div>
      <div className="mt-2 flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: dot }}
          aria-hidden
        />
        <span className="font-medium">{label}</span>
        {latencyMs != null && (
          <span className="ml-auto text-sm tabular-nums text-neutral-400">
            {latencyMs} ms
          </span>
        )}
      </div>
      {detail && (
        <div className="mt-1 truncate text-xs text-neutral-500" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}
