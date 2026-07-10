// src/App.tsx — health panel (cartes de statut + graphe de latence) et chat
// (phase 2), dans deux onglets d'une même page.

import { useState } from "react";
import { TokenGate } from "./components/TokenGate";
import { StatusCard, type Tone } from "./components/StatusCard";
import { LatencyChart } from "./components/LatencyChart";
import { ChatPanel } from "./components/ChatPanel";
import { useStatusStream } from "./hooks/useStatusStream";
import { usePingHistory } from "./hooks/usePingHistory";
import { getToken, setToken as saveToken, clearToken } from "./lib/token";

const RANGES = [
  { label: "24h", hours: 24 },
  { label: "7j", hours: 24 * 7 },
];

const TABS = [
  { id: "health", label: "Health" },
  { id: "chat", label: "Chat" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function toneForCheck(check: { ok: boolean } | null | undefined): Tone {
  if (!check) return "unknown";
  return check.ok ? "good" : "critical";
}

export default function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [rangeHours, setRangeHours] = useState(24);
  const [tab, setTab] = useState<TabId>("health");

  const { status, state } = useStatusStream(token);
  const { history } = usePingHistory(token, rangeHours);

  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          saveToken(t);
          setTokenState(t);
        }}
      />
    );
  }

  const ollama = status?.ollama ?? null;
  const ollamaTone: Tone = !ollama
    ? "unknown"
    : !ollama.ok
      ? "critical"
      : ollama.fallbackModelReady === false
        ? "warning"
        : "good";
  const ollamaDetail =
    ollama?.error ?? (ollama?.fallbackModelReady === false ? "Modèle fallback absent" : undefined);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">clawdeck</h1>
          <p className="text-sm text-neutral-400">
            Health panel OpenClaw ·{" "}
            <span className={state === "open" ? "text-emerald-400" : "text-amber-400"}>
              {state === "open" ? "connecté" : state === "connecting" ? "connexion…" : "déconnecté"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <nav className="flex gap-1 text-sm">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded px-3 py-1.5 ${
                  tab === t.id ? "bg-white/15 text-white" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="text-xs text-neutral-500 hover:text-neutral-300"
            onClick={() => {
              clearToken();
              setTokenState(null);
            }}
          >
            Déconnexion
          </button>
        </div>
      </header>

      {tab === "health" && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatusCard
              title="Gateway OpenClaw"
              tone={toneForCheck(status?.gateway)}
              latencyMs={status?.gateway.latencyMs}
              detail={status?.gateway.error}
            />
            <StatusCard title="Ollama" tone={ollamaTone} latencyMs={ollama?.latencyMs} detail={ollamaDetail} />
            <StatusCard
              title="Ping Cloudflare"
              tone={toneForCheck(status?.ping.cloudflare)}
              latencyMs={status?.ping.cloudflare.latencyMs}
              detail={status?.ping.cloudflare.host}
            />
            <StatusCard
              title="Ping passerelle Orange"
              tone={toneForCheck(status?.ping.orange)}
              latencyMs={status?.ping.orange.latencyMs}
              detail={status?.ping.orange.host}
            />
          </div>

          <section className="mt-6 rounded-lg border border-white/10 bg-neutral-900 p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium text-neutral-300">Latence réseau</h2>
              <div className="flex gap-1 text-xs">
                {RANGES.map((r) => (
                  <button
                    key={r.hours}
                    type="button"
                    onClick={() => setRangeHours(r.hours)}
                    className={`rounded px-2 py-1 ${
                      rangeHours === r.hours ? "bg-white/15 text-white" : "text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <LatencyChart history={history} />
          </section>
        </>
      )}

      {tab === "chat" && (
        <div className="mt-6">
          <ChatPanel token={token} />
        </div>
      )}
    </div>
  );
}
