import { useEffect, useMemo, useRef, useState } from "react";
import { useLogStream, type LogEntry } from "../hooks/useLogStream";

type LevelFilter = "all" | "info" | "warn" | "error";

const FILTERS: Array<{ id: LevelFilter; label: string }> = [
  { id: "all", label: "Tous" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Alertes" },
  { id: "error", label: "Erreurs" },
];

function matchesLevel(entry: LogEntry, filter: LevelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "error") return entry.level === "error" || entry.level === "fatal";
  if (filter === "warn") return entry.level === "warn";
  return entry.level === "info" || entry.level === "debug" || entry.level === "trace";
}

function levelStyle(level: LogEntry["level"]): string {
  if (level === "error" || level === "fatal") return "text-red-300 bg-red-300/8";
  if (level === "warn") return "text-amber-300 bg-amber-300/8";
  if (level === "debug" || level === "trace") return "text-[var(--text-muted)] bg-white/3";
  return "text-sky-300 bg-sky-300/8";
}

function formatTime(timestamp: string | null): string {
  if (!timestamp) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LogsPanel({ token }: { token: string | null }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const { entries, state, error, truncated, clear } = useLogStream(token, !paused);

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!matchesLevel(entry, filter)) return false;
      if (!normalizedQuery) return true;
      return `${entry.subsystem ?? ""} ${entry.message}`.toLowerCase().includes(normalizedQuery);
    });
  }, [entries, filter, query]);

  useEffect(() => {
    if (!followRef.current) return;
    const viewport = viewportRef.current;
    viewport?.scrollTo({ top: viewport.scrollHeight });
  }, [visibleEntries]);

  const connected = state === "open";

  return (
    <section className="overflow-hidden rounded-xl border border-white/8 bg-[var(--surface-panel)]">
      <header className="flex flex-col gap-3 border-b border-white/8 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-sm font-medium">Journal OpenClaw</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">Tail filtré par la gateway · aucune persistance clawdeck</p>
          </div>
          <span className="flex items-center gap-2 rounded-full border border-white/8 bg-black/15 px-2.5 py-1 text-[10px] text-[var(--text-secondary)]" aria-live="polite">
            <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-neutral-500" : connected ? "bg-emerald-400" : "bg-amber-400"}`} />
            {paused ? "En pause" : connected ? "En direct" : "Reconnexion"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="log-search">Filtrer les logs</label>
          <input
            id="log-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Sous-système ou message"
            className="min-h-9 w-full rounded-lg border border-white/8 bg-black/15 px-3 text-xs outline-none placeholder:text-[var(--text-muted)] focus:border-emerald-300/30 sm:w-52"
          />
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            className="min-h-9 rounded-lg border border-white/8 px-3 text-xs text-[var(--text-secondary)] hover:bg-white/5"
          >
            {paused ? "Reprendre" : "Pause"}
          </button>
          <button
            type="button"
            onClick={clear}
            className="min-h-9 rounded-lg px-3 text-xs text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-secondary)]"
          >
            Effacer la vue
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/7 px-4 py-3 lg:px-5">
        <div className="flex gap-1 rounded-lg border border-white/8 bg-black/15 p-1" aria-label="Niveau des logs">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`min-h-8 rounded-md px-3 text-[11px] ${filter === item.id ? "bg-white/10 text-white" : "text-[var(--text-muted)]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="font-mono text-[10px] text-[var(--text-muted)]">
          {visibleEntries.length}/{entries.length} lignes{truncated ? " · tail tronqué" : ""}
        </p>
      </div>

      {error && (
        <div className="border-b border-amber-300/10 bg-amber-300/5 px-4 py-2.5 text-xs text-amber-200 lg:px-5" role="status">
          {error}
        </div>
      )}

      <div
        ref={viewportRef}
        className="h-[calc(100vh-20rem)] min-h-96 max-h-[48rem] overflow-auto bg-[#0b0d0e] font-mono text-[11px]"
        role="log"
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {visibleEntries.length === 0 ? (
          <div className="flex h-full min-h-96 flex-col items-center justify-center px-6 text-center text-[var(--text-muted)]">
            <span className="text-lg" aria-hidden>&gt;_</span>
            <p className="mt-2 font-sans text-sm text-[var(--text-secondary)]">
              {entries.length ? "Aucune ligne ne correspond aux filtres" : "En attente des logs OpenClaw"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/4">
            {visibleEntries.map((entry) => (
              <div key={entry.id} className="grid gap-1 px-4 py-2.5 hover:bg-white/3 sm:grid-cols-[4.5rem_4.5rem_8rem_minmax(0,1fr)] sm:items-start sm:gap-3 lg:px-5">
                <span className="text-[var(--text-muted)]">{formatTime(entry.timestamp)}</span>
                <span className={`w-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${levelStyle(entry.level)}`}>
                  {entry.level}
                </span>
                <span className="truncate text-emerald-200/70" title={entry.subsystem ?? undefined}>
                  {entry.subsystem ?? "openclaw"}
                </span>
                <span className="whitespace-pre-wrap break-words leading-5 text-[var(--text-secondary)]">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
