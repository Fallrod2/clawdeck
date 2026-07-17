// src/components/ChatPanel.tsx — conversation principale, streaming et outils.

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage, ToolCall } from "../lib/chatTypes";
import { useChat } from "../hooks/useChat";

function formatPayload(value: unknown): string | null {
  if (value == null) return null;
  const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!formatted) return null;
  return formatted.length > 8_000 ? `${formatted.slice(0, 8_000)}\n… contenu tronqué` : formatted;
}

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const complete = tool.phase === "result";
  const label = !complete ? "En cours" : tool.isError ? "Erreur" : "Terminé";
  const args = formatPayload(tool.args);
  const result = formatPayload(tool.result);

  return (
    <details className="group mt-3 overflow-hidden rounded-lg border border-white/8 bg-black/20 text-xs">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-[var(--text-secondary)] marker:content-none">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            !complete ? "bg-amber-400" : tool.isError ? "bg-red-400" : "bg-emerald-400"
          }`}
          aria-hidden
        />
        <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">{tool.name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</span>
        <span className="text-[var(--text-muted)] transition-transform group-open:rotate-180" aria-hidden>⌄</span>
      </summary>
      {(args || result) && (
        <div className="space-y-3 border-t border-white/7 px-3 py-3">
          {args && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Arguments</p>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[var(--text-secondary)]">{args}</pre>
            </div>
          )}
          {result && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Résultat</p>
              <pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 ${tool.isError ? "text-red-300" : "text-[var(--text-secondary)]"}`}>{result}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const time = new Date(message.timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <article className={`flex ${isUser ? "justify-end" : "justify-start"}`} aria-label={`Message ${isUser ? "utilisateur" : "assistant"} à ${time}`}>
      <div className={`max-w-[92%] sm:max-w-[82%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser
              ? "rounded-br-md border border-emerald-300/12 bg-emerald-300/9"
              : "rounded-bl-md border border-white/8 bg-[var(--surface-raised)]"
          }`}
        >
          {message.text ? (
            <div className="prose prose-invert prose-sm max-w-none break-words prose-headings:mb-2 prose-headings:mt-4 prose-p:my-1.5 prose-p:leading-6 prose-a:text-emerald-300 prose-pre:my-3 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:border prose-pre:border-white/8 prose-pre:bg-black/25 prose-code:text-[0.82em]">
              <Markdown>{message.text}</Markdown>
            </div>
          ) : message.pending ? (
            <span className="inline-flex items-center gap-1 py-1 text-[var(--text-muted)]" aria-label="Réponse en cours">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </span>
          ) : null}
          {message.toolCalls.map((tool) => (
            <ToolCallCard key={tool.id} tool={tool} />
          ))}
          {message.error && <p className="mt-2 text-xs text-red-300">{message.error}</p>}
        </div>
        <p className={`mt-1.5 px-1 font-mono text-[10px] text-[var(--text-muted)] ${isUser ? "text-right" : "text-left"}`}>
          {isUser ? "Vous" : "OpenClaw"} · {time}{message.pending ? " · en cours" : ""}
        </p>
      </div>
    </article>
  );
}

export function ChatPanel({ token }: { token: string | null }) {
  const { messages, wsState, gatewayConnected, send } = useChat(token);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const followMessagesRef = useRef(true);

  useEffect(() => {
    if (!followMessagesRef.current) return;
    const viewport = scrollRef.current;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const connected = wsState === "open" && gatewayConnected;
  const statusLabel =
    wsState === "connecting"
      ? "Connexion au relais"
      : wsState !== "open"
        ? "Relais déconnecté"
        : gatewayConnected
          ? "Gateway connectée"
          : "Gateway indisponible";

  function submit() {
    if (!connected || !draft.trim()) return;
    if (send(draft)) {
      setDraft("");
      followMessagesRef.current = true;
    }
  }

  return (
    <section className="flex h-[calc(100vh-14rem)] min-h-[34rem] max-h-[54rem] flex-col overflow-hidden rounded-xl border border-white/8 bg-[var(--surface-panel)]">
      <header className="flex min-h-16 items-center justify-between gap-3 border-b border-white/8 px-4 sm:px-5">
        <div>
          <h2 className="text-sm font-medium">Conversation</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Session principale · miroir du canal d'origine</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/8 bg-black/15 px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]" aria-live="polite">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden />
          <span className="hidden sm:inline">{statusLabel}</span>
          <span className="sm:hidden">{connected ? "Connecté" : "Hors ligne"}</span>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6"
        role="log"
        aria-live="polite"
        aria-label="Messages de la conversation"
        onScroll={(event) => {
          const element = event.currentTarget;
          followMessagesRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {messages.length === 0 && (
          <div className="flex h-full min-h-60 flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/8 bg-white/3 font-mono text-xs text-[var(--text-muted)]" aria-hidden>
              &gt;_
            </div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">La conversation est prête</p>
            <p className="mt-2 max-w-xs text-xs leading-5 text-[var(--text-muted)]">
              Les messages et appels d'outils de la session principale apparaîtront ici.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>

      <div className="border-t border-white/8 bg-black/10 p-3 sm:p-4">
        <form
          className="rounded-xl border border-white/10 bg-black/20 p-2 transition-colors focus-within:border-emerald-300/25"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="chat-draft" className="sr-only">Message à OpenClaw</label>
          <textarea
            id="chat-draft"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={connected ? "Écrire un message…" : "Envoi indisponible tant que la gateway est hors ligne"}
            disabled={!connected}
            className="max-h-32 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-3 px-1 pt-1">
            <p className="hidden text-[10px] text-[var(--text-muted)] sm:block">Entrée pour envoyer · Maj + Entrée pour une ligne</p>
            <button
              type="submit"
              disabled={!connected || !draft.trim()}
              className="ml-auto min-h-9 rounded-lg bg-emerald-300 px-4 text-xs font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              Envoyer
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
