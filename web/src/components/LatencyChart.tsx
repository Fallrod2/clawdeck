// src/components/LatencyChart.tsx — graphe de latence (Cloudflare / passerelle
// Orange). Un seul axe (ms), deux séries, lecture détaillée au survol et au
// clavier. Honnêteté d'abord (UI_UX §5) : les trous de collecte ne sont jamais
// reliés, les stats de période servent de conclusion textuelle et l'âge des
// données est annoncé quand le rafraîchissement ne répond plus.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PingHistory, PingRow } from "../lib/types";
import { formatRelativeAgeFr, useNow } from "../hooks/useNow";

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

// Deux buckets séparés de plus de 1,5 × bucketMs = trou de collecte : le tracé
// s'interrompt au lieu de relier artificiellement les deux périodes.
const GAP_FACTOR = 1.5;
// usePingHistory rafraîchit toutes les 30 s : au-delà de deux cycles sans
// réponse réussie, le graphe est annoncé périmé.
const STALE_AFTER_MS = 60_000;

interface SeriesStats {
  buckets: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  failures: number;
  failurePct: number | null;
  gaps: number;
}

// Percentile « nearest-rank » sur un tableau déjà trié croissant.
function percentile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[index] ?? null;
}

function computeStats(points: PingRow[], bucketMs: number): SeriesStats {
  const latencies = points
    .map((p) => p.latencyMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.ts - points[i - 1]!.ts > bucketMs * GAP_FACTOR) gaps += 1;
  }
  const failures = points.filter((p) => p.ok === 0).length;
  return {
    buckets: points.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    min: latencies[0] ?? null,
    max: latencies[latencies.length - 1] ?? null,
    failures,
    failurePct: points.length > 0 ? (failures / points.length) * 100 : null,
    gaps,
  };
}

function formatMs(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)} ms`;
}

function formatPct(value: number | null): string {
  if (value == null) return "—";
  if (value === 0) return "0 %";
  if (value < 1) return "<1 %";
  return `${Math.round(value)} %`;
}

function formatGaps(gaps: number): string {
  if (gaps === 0) return "collecte continue";
  return gaps === 1 ? "1 trou de collecte" : `${gaps} trous de collecte`;
}

function formatTickDate(ts: number, withTime: boolean): string {
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function LatencyChart({
  history,
  lastUpdatedAt,
}: {
  history: PingHistory | null;
  /** Dernière réponse réussie de /api/pings/history (usePingHistory.lastUpdatedAt). */
  lastUpdatedAt?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const now = useNow(5_000);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const bucketMs = history?.bucketMs ?? 5_000;

  const series: Series[] = useMemo(
    () => [
      { key: "cloudflare", points: history?.cloudflare ?? [], ...SERIES_STYLE.cloudflare },
      { key: "orange", points: history?.orange ?? [], ...SERIES_STYLE.orange },
    ],
    [history],
  );

  const allPoints = useMemo(() => series.flatMap((s) => s.points), [series]);

  // Instants distincts triés : parcours clavier du tooltip (flèches).
  const tsList = useMemo(
    () => Array.from(new Set(allPoints.map((p) => p.ts))).sort((a, b) => a - b),
    [allPoints],
  );

  // Tolérance de lecture proportionnelle à la taille réelle des buckets :
  // au-delà de 3/4 de bucket, un point ne décrit plus l'instant visé.
  const hoverToleranceMs = bucketMs * 0.75;

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

  const seriesStats = useMemo(
    () => series.map((s) => ({ ...s, stats: computeStats(s.points, bucketMs) })),
    [series, bucketMs],
  );

  const isStale = lastUpdatedAt != null && now - lastUpdatedAt > STALE_AFTER_MS;

  function pathFor(s: Series) {
    if (!scales) return "";
    const maxGapMs = bucketMs * GAP_FACTOR;
    let d = "";
    let lastDrawnTs: number | null = null;
    for (const p of s.points) {
      if (p.latencyMs == null) {
        // Bucket entièrement en échec : le tracé s'interrompt, le vide reste visible.
        lastDrawnTs = null;
        continue;
      }
      const x = scales.xScale(p.ts);
      const y = scales.yScale(p.latencyMs);
      if (lastDrawnTs != null && p.ts - lastDrawnTs <= maxGapMs) {
        d += ` L ${x} ${y}`;
      } else {
        // Nouveau segment après un trou ; le « L » sur place rend visible un
        // point isolé grâce au strokeLinecap round.
        d += ` M ${x} ${y} L ${x} ${y}`;
      }
      lastDrawnTs = p.ts;
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

  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (tsList.length === 0) return;
    if (e.key === "Escape") {
      setHoverTs(null);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    setHoverTs((current) => {
      // Départ sur le relevé le plus récent, le plus utile en exploitation.
      if (current == null) return tsList[tsList.length - 1] ?? null;
      const index = tsList.indexOf(current);
      if (index === -1) return tsList[tsList.length - 1] ?? null;
      const next = Math.min(tsList.length - 1, Math.max(0, index + step));
      return tsList[next] ?? null;
    });
  }

  const hoverX = scales && hoverTs != null ? scales.xScale(hoverTs) : null;
  const withTime = history != null && history.bucketMs < 10 * 60_000;
  const xTicks = scales
    ? [
        { ts: scales.minTs, anchor: "start" as const },
        { ts: scales.minTs + (scales.maxTs - scales.minTs) / 2, anchor: "middle" as const },
        { ts: scales.maxTs, anchor: "end" as const },
      ]
    : [];

  const descText = scales
    ? [
        `Latence en millisecondes du ${formatTickDate(scales.minTs, true)} au ${formatTickDate(scales.maxTs, true)}.`,
        ...seriesStats.map(({ label, stats }) =>
          stats.buckets === 0
            ? `${label} : aucune donnée.`
            : `${label} : latence de ${formatMs(stats.min)} à ${formatMs(stats.max)}, p95 ${formatMs(stats.p95)}, ` +
              `${stats.failures === 0 ? "aucun échec" : `${stats.failures} ${stats.failures === 1 ? "bucket en échec" : "buckets en échec"}`}` +
              `${stats.gaps > 0 ? `, ${formatGaps(stats.gaps)}` : ""}.`,
        ),
      ].join(" ")
    : "Aucune donnée de latence sur la période.";

  return (
    <div
      ref={containerRef}
      className="relative"
      role="group"
      aria-label="Graphique de latence réseau. Survoler le tracé ou utiliser les flèches gauche et droite pour lire un relevé, Échap pour fermer la lecture."
    >
      {!scales ? (
        <div className="flex h-64 flex-col items-center justify-center text-center">
          <span className="font-mono text-xl text-[var(--text-muted)]" aria-hidden>—</span>
          {history == null ? (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Chargement de l'historique réseau…</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">Pas encore de données réseau</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Le premier relevé apparaîtra après une sonde réussie.</p>
            </>
          )}
        </div>
      ) : (
        <>
          {isStale && lastUpdatedAt != null && (
            <p className="mb-2 flex items-center gap-2 text-[11px] text-amber-300">
              <span aria-hidden>!</span>
              Données périmées — dernière réponse {formatRelativeAgeFr(now - lastUpdatedAt)}
            </p>
          )}

          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            className="h-64 w-full touch-none"
            onPointerMove={handleMove}
            onPointerLeave={() => setHoverTs(null)}
            onKeyDown={handleKeyDown}
            onBlur={() => setHoverTs(null)}
            tabIndex={0}
            role="img"
            aria-labelledby="latency-chart-title latency-chart-description"
          >
            <title id="latency-chart-title">Latence Internet et réseau local</title>
            <desc id="latency-chart-description">{descText}</desc>
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
                {formatTickDate(tick.ts, withTime)}
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
              className="pointer-events-none absolute top-2 w-48 rounded-lg border border-white/10 bg-[var(--surface-raised)] px-3 py-2.5 text-xs shadow-xl"
              style={{ left: `min(${(hoverX / width) * 100}%, calc(100% - 200px))` }}
            >
              <div className="mb-2 border-b border-white/7 pb-2 font-mono text-[10px] text-[var(--text-muted)]">
                {new Date(hoverTs).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
              {series.map((s) => {
                const p = closest(s, hoverTs);
                return (
                  <div key={s.key} className="mt-1.5 flex items-center gap-2 text-[var(--text-primary)]">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                    <span className="truncate text-[var(--text-secondary)]">{s.label}</span>
                    <span className="ml-auto font-medium tabular-nums">
                      {p?.latencyMs != null
                        ? `${Math.round(p.latencyMs)} ms${p.ok === 0 ? " · échec" : ""}`
                        : p && p.ok === 0
                          ? "échec"
                          : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2 border-t border-white/6 pt-3 text-[11px]">
            {seriesStats.map(({ key, label, color, stats }) => (
              <div key={key} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="flex min-w-36 items-center gap-2 text-[var(--text-secondary)]">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                  {label}
                </span>
                {stats.buckets === 0 ? (
                  <span className="text-[var(--text-muted)]">aucune donnée sur la période</span>
                ) : (
                  <>
                    <span className="text-[var(--text-muted)]">
                      p50{" "}
                      <span className="font-mono tabular-nums text-[var(--text-secondary)]">{formatMs(stats.p50)}</span>
                    </span>
                    <span className="text-[var(--text-muted)]">
                      p95{" "}
                      <span className="font-mono tabular-nums text-[var(--text-secondary)]">{formatMs(stats.p95)}</span>
                    </span>
                    <span className="text-[var(--text-muted)]">
                      échecs{" "}
                      <span className={`font-mono tabular-nums ${stats.failures > 0 ? "text-amber-300" : "text-[var(--text-secondary)]"}`}>
                        {formatPct(stats.failurePct)}
                      </span>
                    </span>
                    <span className="text-[var(--text-muted)]">{formatGaps(stats.gaps)}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
