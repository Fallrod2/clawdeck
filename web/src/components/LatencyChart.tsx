// src/components/LatencyChart.tsx — graphe de latence (Cloudflare / passerelle
// Orange). Un seul axe (ms), deux séries et une lecture détaillée au survol.

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { PingHistory, PingRow } from "../lib/types";

interface Series {
  key: "cloudflare" | "orange";
  label: string;
  color: string;
  points: PingRow[];
}

// Slots catégoriels 1 et 2 de la palette validée (variante sombre).
const SERIES_STYLE: Record<Series["key"], { label: string; color: string }> = {
  cloudflare: { label: "Internet · 1.1.1.1", color: "var(--chart-internet)" },
  orange: { label: "Passerelle locale", color: "var(--chart-local)" },
};

const DEFAULT_WIDTH = 800;
const HEIGHT = 260;
const PAD = { top: 18, right: 12, bottom: 34, left: 42 };

export function LatencyChart({ history }: { history: PingHistory | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const series: Series[] = useMemo(
    () => [
      { key: "cloudflare", points: history?.cloudflare ?? [], ...SERIES_STYLE.cloudflare },
      { key: "orange", points: history?.orange ?? [], ...SERIES_STYLE.orange },
    ],
    [history],
  );

  const allPoints = useMemo(() => series.flatMap((s) => s.points), [series]);
  const hoverToleranceMs = Math.max((history?.bucketMs ?? 5_000) * 1.5, 15_000);

  const scales = useMemo(() => {
    const innerW = width - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    if (allPoints.length === 0) return null;

    const tsValues = allPoints.map((p) => p.ts);
    const minTs = Math.min(...tsValues);
    const maxTs = Math.max(...tsValues);
    const latencies = allPoints.map((p) => p.latencyMs ?? 0);
    const maxY = Math.max(20, ...latencies) * 1.15;

    const xScale = (ts: number) =>
      PAD.left + (maxTs === minTs ? innerW / 2 : ((ts - minTs) / (maxTs - minTs)) * innerW);
    const yScale = (v: number) => PAD.top + innerH - (v / maxY) * innerH;

    const tickCount = 4;
    const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((maxY / tickCount) * i));

    return { xScale, yScale, yTicks, minTs, maxTs };
  }, [allPoints, width]);

  function pathFor(s: Series) {
    if (!scales) return "";
    let d = "";
    let drawing = false;
    for (const p of s.points) {
      if (p.latencyMs == null) {
        drawing = false;
        continue;
      }
      const x = scales.xScale(p.ts);
      const y = scales.yScale(p.latencyMs);
      d += drawing ? ` L ${x} ${y}` : ` M ${x} ${y}`;
      drawing = true;
    }
    return d;
  }

  function closest(s: Series, ts: number): PingRow | null {
    let best: PingRow | null = null;
    let bestDiff = Infinity;
    for (const p of s.points) {
      const diff = Math.abs(p.ts - ts);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    }
    return best && bestDiff <= hoverToleranceMs ? best : null;
  }

  function handleMove(e: PointerEvent<SVGSVGElement>) {
    if (!scales || !svgRef.current || allPoints.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const targetTs = scales.minTs + xFrac * (scales.maxTs - scales.minTs);

    let closestTs = allPoints[0]!.ts;
    let bestDiff = Infinity;
    for (const p of allPoints) {
      const diff = Math.abs(p.ts - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        closestTs = p.ts;
      }
    }
    setHoverTs(closestTs);
  }

  if (!scales) {
    return (
      <div className="flex h-64 flex-col items-center justify-center text-center">
        <span className="font-mono text-xl text-[var(--text-muted)]" aria-hidden>—</span>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">Pas encore de données réseau</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Le premier relevé apparaîtra après une sonde réussie.</p>
      </div>
    );
  }

  const hoverX = hoverTs != null ? scales.xScale(hoverTs) : null;
  const xTicks = [
    { ts: scales.minTs, anchor: "start" as const },
    { ts: scales.minTs + (scales.maxTs - scales.minTs) / 2, anchor: "middle" as const },
    { ts: scales.maxTs, anchor: "end" as const },
  ];

  return (
    <div ref={containerRef} className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="h-64 w-full touch-none"
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverTs(null)}
        role="img"
        aria-labelledby="latency-chart-title latency-chart-description"
      >
        <title id="latency-chart-title">Latence Internet et réseau local</title>
        <desc id="latency-chart-description">Évolution de la latence en millisecondes sur la période sélectionnée.</desc>
        {scales.yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={scales.yScale(t)}
              y2={scales.yScale(t)}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={scales.yScale(t)}
              fontSize={11}
              fill="var(--text-muted)"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {t}
            </text>
          </g>
        ))}

        {xTicks.map((tick) => (
          <text
            key={`${tick.ts}-${tick.anchor}`}
            x={scales.xScale(tick.ts)}
            y={HEIGHT - 8}
            fontSize={10}
            fill="var(--text-muted)"
            textAnchor={tick.anchor}
          >
            {new Date(tick.ts).toLocaleString("fr-FR", {
              day: "2-digit",
              month: "2-digit",
              ...(history && history.bucketMs < 10 * 60_000 ? { hour: "2-digit", minute: "2-digit" } : {}),
            })}
          </text>
        ))}

        {series.map((s) => (
          <path
            key={s.key}
            d={pathFor(s)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {hoverX != null && (
          <g>
            <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
            {series.map((s) => {
              const p = hoverTs != null ? closest(s, hoverTs) : null;
              if (!p || p.latencyMs == null) return null;
              return (
                <circle
                  key={s.key}
                  cx={hoverX}
                  cy={scales.yScale(p.latencyMs)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-panel)"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}
      </svg>

      {hoverTs != null && hoverX != null && (
        <div
          className="pointer-events-none absolute top-2 w-44 rounded-lg border border-white/10 bg-[var(--surface-raised)] px-3 py-2.5 text-xs shadow-xl"
          style={{ left: `min(${(hoverX / width) * 100}%, calc(100% - 184px))` }}
        >
          <div className="mb-2 border-b border-white/7 pb-2 font-mono text-[10px] text-[var(--text-muted)]">
            {new Date(hoverTs).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </div>
          {series.map((s) => {
            const p = closest(s, hoverTs);
            return (
              <div key={s.key} className="mt-1.5 flex items-center gap-2 text-[var(--text-primary)]">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="truncate text-[var(--text-secondary)]">{s.label}</span>
                <span className="ml-auto font-medium tabular-nums">
                  {p?.latencyMs != null ? `${Math.round(p.latencyMs)} ms` : p && !p.ok ? "×" : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-white/6 pt-3 text-[11px] text-[var(--text-secondary)]">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
