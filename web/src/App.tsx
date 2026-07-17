// src/App.tsx — shell principal : contexte global, navigation et vues métier.

import { useEffect, useMemo, useState } from "react";
import { TokenGate } from "./components/TokenGate";
import { StatusCard, type Tone } from "./components/StatusCard";
import { LatencyChart } from "./components/LatencyChart";
import { ChatPanel } from "./components/ChatPanel";
import { LogsPanel } from "./components/LogsPanel";
import { useStatusStream } from "./hooks/useStatusStream";
import { usePingHistory } from "./hooks/usePingHistory";
import { getToken, setToken as saveToken, clearToken } from "./lib/token";

const RANGES = [
  { label: "24 heures", shortLabel: "24 h", hours: 24 },
  { label: "7 jours", shortLabel: "7 j", hours: 24 * 7 },
];

const TABS = [
  { id: "health", label: "Vue d'ensemble" },
  { id: "chat", label: "Chat" },
  { id: "logs", label: "Logs" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function toneForCheck(check: { ok: boolean } | null | undefined): Tone {
  if (!check) return "unknown";
  return check.ok ? "good" : "critical";
}

function formatUpdateTime(timestamp?: number) {
  if (!timestamp) return "En attente du premier relevé";
  return `Mis à jour à ${new Date(timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

function formatActivity(timestamp: number | null | undefined): string {
  if (!timestamp) return "Aucune activité";
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 60_000) return "À l'instant";
  if (ageMs < 60 * 60_000) return `Il y a ${Math.floor(ageMs / 60_000)} min`;
  if (ageMs < 24 * 60 * 60_000) return `Il y a ${Math.floor(ageMs / (60 * 60_000))} h`;
  return new Date(timestamp).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function formatUptime(uptimeMs: number | null | undefined): string {
  if (uptimeMs == null) return "—";
  const hours = Math.floor(uptimeMs / (60 * 60_000));
  if (hours < 1) return `${Math.max(1, Math.floor(uptimeMs / 60_000))} min`;
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

export default function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [rangeHours, setRangeHours] = useState(24);
  const [tab, setTab] = useState<TabId>("health");

  const { status, state, rejectedToken } = useStatusStream(token);
  const { history } = usePingHistory(token, rangeHours);

  useEffect(() => {
    if (state !== "unauthorized" || !token || rejectedToken !== token) return;
    clearToken();
    setTokenState(null);
    setTokenError("Ce token n'est pas reconnu. Vérifie AUTH_TOKEN puis réessaie.");
  }, [state, rejectedToken, token]);

  const overall = useMemo(() => {
    if (!status) return { tone: "unknown" as Tone, label: "Initialisation des sondes" };
    const checks = [status.gateway.ok, status.ollama.ok, status.ping.cloudflare.ok, status.ping.orange.ok];
    if (status.openclaw) checks.push(status.openclaw.connected && status.openclaw.healthy !== false);
    if (status.openclaw?.whatsapp.healthy !== null && status.openclaw?.whatsapp.healthy !== undefined) {
      checks.push(status.openclaw.whatsapp.healthy);
    }
    const failures = checks.filter((ok) => !ok).length;
    if (failures === 0 && status.openclaw?.usingFallback) {
      return {
        tone: "warning" as Tone,
        label: `Fallback local actif : ${status.openclaw.provider}/${status.openclaw.model}`,
      };
    }
    if (failures === 0) return { tone: "good" as Tone, label: "Tous les systèmes sondés répondent" };
    if (failures === 1) return { tone: "warning" as Tone, label: "Un système demande votre attention" };
    return { tone: "critical" as Tone, label: `${failures} systèmes sont indisponibles` };
  }, [status]);

  if (!token) {
    return (
      <TokenGate
        error={tokenError}
        onSubmit={(nextToken) => {
          setTokenError(null);
          saveToken(nextToken);
          setTokenState(nextToken);
        }}
      />
    );
  }

  const ollama = status?.ollama ?? null;
  const openclaw = status?.openclaw ?? null;
  const ollamaTone: Tone = !ollama
    ? "unknown"
    : !ollama.ok
      ? "critical"
      : ollama.fallbackModelReady === false
        ? "warning"
        : "good";
  const ollamaDetail =
    ollama?.error ??
    (ollama?.fallbackModelReady === false ? "Modèle de fallback absent" : "Fallback local prêt");
  const providerTone: Tone = !openclaw
    ? "unknown"
    : !openclaw.connected || openclaw.healthy === false || openclaw.modelAvailable === false
      ? "critical"
      : openclaw.usingFallback
        ? "warning"
        : "good";
  const whatsappTone: Tone = !openclaw
    ? "unknown"
    : openclaw.whatsapp.healthy === true
      ? "good"
      : openclaw.whatsapp.healthy === false
        ? "critical"
        : "warning";

  const streamLabel =
    state === "open" ? "Temps réel actif" : state === "connecting" ? "Connexion en cours" : "Flux interrompu";
  const streamGood = state === "open";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-white/8 bg-[#090b0c]/90 backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <button
            type="button"
            className="flex shrink-0 items-center gap-3 rounded-md text-left"
            onClick={() => setTab("health")}
            aria-label="Retour à la vue d'ensemble"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-300/15 bg-emerald-300/8 font-mono text-[11px] font-semibold text-emerald-200">
              cd
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-tight">clawdeck</span>
              <span className="hidden text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)] lg:block">
                OpenClaw console
              </span>
            </span>
          </button>

          <nav className="ml-4 hidden items-center gap-1 sm:flex" aria-label="Navigation principale">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? "page" : undefined}
                className={`min-h-10 rounded-lg px-3 text-sm transition-colors ${
                  tab === item.id
                    ? "bg-white/8 text-white"
                    : "text-[var(--text-muted)] hover:bg-white/4 hover:text-[var(--text-secondary)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <div
              className="flex min-h-9 items-center gap-2 rounded-full border border-white/8 bg-white/3 px-3 text-xs text-[var(--text-secondary)]"
              aria-live="polite"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${streamGood ? "bg-emerald-400" : "bg-amber-400"}`}
                aria-hidden
              />
              <span className="hidden xs:inline sm:inline">{streamLabel}</span>
              <span className="sm:hidden">{streamGood ? "En direct" : "Hors ligne"}</span>
            </div>
            <button
              type="button"
              className="min-h-9 rounded-lg px-2.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-white/5 hover:text-[var(--text-primary)]"
              onClick={() => {
                clearToken();
                setTokenState(null);
              }}
            >
              Quitter
            </button>
          </div>
        </div>

        <nav className="mx-auto grid max-w-6xl grid-cols-3 gap-1 px-4 pb-3 sm:hidden" aria-label="Navigation principale">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
              className={`min-h-10 rounded-lg px-3 text-sm transition-colors ${
                tab === item.id ? "bg-white/9 text-white" : "text-[var(--text-muted)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
        {tab === "health" ? (
          <>
            <section className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
                  Supervision
                </p>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Vue d'ensemble</h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">
                  État d'OpenClaw, du fallback local et de la liaison réseau du Mac mini.
                </p>
              </div>
              <p className="font-mono text-[11px] text-[var(--text-muted)]">
                {formatUpdateTime(status?.timestamp)}
              </p>
            </section>

            <section
              className={`mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 ${
                overall.tone === "good"
                  ? "border-emerald-300/12 bg-emerald-300/6"
                  : overall.tone === "critical"
                    ? "border-red-300/12 bg-red-300/6"
                    : "border-amber-300/12 bg-amber-300/6"
              }`}
              aria-live="polite"
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                  overall.tone === "good"
                    ? "bg-emerald-300/12 text-emerald-200"
                    : overall.tone === "critical"
                      ? "bg-red-300/12 text-red-200"
                      : "bg-amber-300/12 text-amber-200"
                }`}
                aria-hidden
              >
                {overall.tone === "good" ? "✓" : overall.tone === "unknown" ? "…" : "!"}
              </span>
              <p className="text-sm text-[var(--text-secondary)]">{overall.label}</p>
            </section>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="État des services">
              <StatusCard
                title="Gateway OpenClaw"
                code="GW"
                tone={!status?.gateway
                  ? "unknown"
                  : !status.gateway.ok || openclaw?.connected === false || openclaw?.healthy === false
                    ? "critical"
                    : "good"}
                detail={status?.gateway.error || (openclaw?.version
                  ? `v${openclaw.version} · RPC ${openclaw.healthDurationMs ?? "—"} ms`
                  : "Passerelle de contrôle")}
                metricLabel="Uptime"
                metricValue={formatUptime(openclaw?.uptimeMs)}
              />
              <StatusCard
                title="Provider actif"
                code="LLM"
                tone={providerTone}
                detail={openclaw?.model ? `${openclaw.provider ?? "provider"}/${openclaw.model}` : openclaw?.error || "En attente de la session"}
                metricLabel={openclaw?.usingFallback ? "Mode" : "Provider"}
                metricValue={openclaw?.usingFallback ? "Fallback" : openclaw?.provider ?? "—"}
              />
              <StatusCard
                title="WhatsApp"
                code="WA"
                tone={whatsappTone}
                detail={openclaw?.whatsapp.lastError || (openclaw?.whatsapp.connected ? "Compte lié et connecté" : "Canal non connecté")}
                metricLabel="Activité"
                metricValue={formatActivity(openclaw?.whatsapp.lastActivityAt)}
              />
              <StatusCard
                title="Ollama"
                code="AI"
                tone={ollamaTone}
                latencyMs={ollama?.latencyMs}
                detail={ollamaDetail}
              />
              <StatusCard
                title="Internet"
                code="WAN"
                tone={toneForCheck(status?.ping.cloudflare)}
                latencyMs={status?.ping.cloudflare.latencyMs}
                detail={status?.ping.cloudflare.host || "Cloudflare 1.1.1.1"}
              />
              <StatusCard
                title="Passerelle locale"
                code="LAN"
                tone={toneForCheck(status?.ping.orange)}
                latencyMs={status?.ping.orange.latencyMs}
                detail={status?.ping.orange.host || "Réseau local"}
              />
            </section>

            <section className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-[var(--surface-panel)]">
              <div className="flex flex-col gap-3 border-b border-white/7 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div>
                  <h2 className="text-sm font-medium">Latence réseau</h2>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Internet et passerelle locale, agrégés sur la période.</p>
                </div>
                <div className="flex w-fit gap-1 rounded-lg border border-white/8 bg-black/15 p-1" aria-label="Période du graphique">
                  {RANGES.map((range) => (
                    <button
                      key={range.hours}
                      type="button"
                      onClick={() => setRangeHours(range.hours)}
                      aria-label={range.label}
                      aria-pressed={rangeHours === range.hours}
                      className={`min-h-8 rounded-md px-3 text-xs transition-colors ${
                        rangeHours === range.hours
                          ? "bg-white/10 text-white shadow-sm"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                      }`}
                    >
                      {range.shortLabel}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-4 sm:p-5">
                <LatencyChart history={history} />
              </div>
            </section>
          </>
        ) : tab === "chat" ? (
          <>
            <section className="mb-6">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
                Session principale
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Chat OpenClaw</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">
                Conversation en direct avec l'agent et visibilité sur ses appels d'outils.
              </p>
            </section>
            <ChatPanel token={token} />
          </>
        ) : (
          <>
            <section className="mb-6">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
                Diagnostic temps réel
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Logs OpenClaw</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">
                Événements récents de la gateway, filtrés à la source et conservés uniquement dans cette vue.
              </p>
            </section>
            <LogsPanel token={token} />
          </>
        )}
      </main>
    </div>
  );
}
