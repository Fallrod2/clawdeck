// src/components/LatencyChart.tsx — graphe de latence (Cloudflare / passerelle
// Orange). Un seul axe (ms), 2 séries catégorielles, hover crosshair + tooltip,
// légende toujours présente pour ≥2 séries (voir skill dataviz).

import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { PingHistory, PingRow } from "../lib/types";

interface Series {
  key: "cloudflare" | "orange";
  label: string;
  color: string;
  points: PingRow[];
}

// Slots catégoriels 1 et 2 de la palette validée (variante sombre).
const SERIES_STYLE: Record<Series["key"], { label: string; color: string }> = {
  cloudflare: { label: "Cloudflare (1.1.1.1)", color: "#3987e5" },
  orange: { label: "Passerelle Orange", color: "#199e70" },
};

const WIDTH = 800;
const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };
const HOVER_TOLERANCE_MS = 20 * 60_000; // 20 min : au-delà, on n'affiche pas de valeur

export function LatencyChart({ history }: { history: PingHistory | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);

  const series: Series[] = useMemo(
    () => [
      { key: "cloudflare", points: history?.cloudflare ?? [], ...SERIES_STYLE.cloudflare },
      { key: "orange", points: history?.orange ?? [], ...SERIES_STYLE.orange },
    ],
    [history],
  );

  const allPoints = useMemo(() => series.flatMap((s) => s.points), [series]);

  const scales = useMemo(() => {
    const innerW = WIDTH - PAD.left - PAD.right;
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
  }, [allPoints]);

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
    return best && bestDiff <= HOVER_TOLERANCE_MS ? best : null;
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
      <div className="flex h-60 items-center justify-center text-sm text-neutral-500">
        Pas encore de données de ping.
      </div>
    );
  }

  const hoverX = hoverTs != null ? scales.xScale(hoverTs) : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full touch-none"
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverTs(null)}
      >
        {scales.yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={scales.yScale(t)}
              y2={scales.yScale(t)}
              stroke="#2c2c2a"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={scales.yScale(t)}
              fontSize={11}
              fill="#898781"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {t}
            </text>
          </g>
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
            <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#383835" strokeWidth={1} />
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
                  stroke="#1a1a19"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}
      </svg>

      {hoverTs != null && hoverX != null && (
        <div
          className="pointer-events-none absolute top-2 w-40 rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-xs shadow-lg"
          style={{ left: `min(${(hoverX / WIDTH) * 100}%, calc(100% - 168px))` }}
        >
          <div className="mb-1 text-neutral-400">
            {new Date(hoverTs).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </div>
          {series.map((s) => {
            const p = closest(s, hoverTs);
            return (
              <div key={s.key} className="flex items-center gap-2 text-neutral-100">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="truncate text-neutral-400">{s.label}</span>
                <span className="ml-auto font-medium tabular-nums">
                  {p?.latencyMs != null ? `${Math.round(p.latencyMs)} ms` : p && !p.ok ? "×" : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex gap-4 text-xs text-neutral-400">
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
