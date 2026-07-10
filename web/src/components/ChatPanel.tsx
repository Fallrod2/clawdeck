// src/components/ChatPanel.tsx — chat riche (phase 2) : markdown, tool calls
// visibles, streaming. Voir hooks/useChat.ts pour la traduction du flux brut.

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage, ToolCall } from "../lib/chatTypes";
import { useChat } from "../hooks/useChat";

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const dot = tool.phase === "result" ? (tool.isError ? "#d03b3b" : "#0ca30c") : "#fab219";
  const label = tool.phase === "start" ? "en cours" : tool.phase === "update" ? "en cours" : tool.isError ? "erreur" : "terminé";

  return (
    <div className="mt-2 rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden />
        <span className="font-mono text-neutral-300">{tool.name}</span>
        <span className="ml-auto text-neutral-500">{label}</span>
      </div>
      {tool.phase === "start" && tool.args != null && (
        <pre className="mt-1 overflow-x-auto text-neutral-500">{JSON.stringify(tool.args)}</pre>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-lg px-4 py-2 ${isUser ? "bg-white/10" : "bg-neutral-900 border border-white/10"}`}>
        {message.text ? (
          <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-pre:my-2">
            <Markdown>{message.text}</Markdown>
          </div>
        ) : message.pending ? (
          <span className="text-neutral-500">…</span>
        ) : null}
        {message.toolCalls.map((t) => (
          <ToolCallCard key={t.id} tool={t} />
        ))}
        {message.error && <div className="mt-1 text-xs text-red-400">{message.error}</div>}
      </div>
    </div>
  );
}

export function ChatPanel({ token }: { token: string | null }) {
  const { messages, wsState, gatewayConnected, send } = useChat(token);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const statusLabel =
    wsState !== "open" ? "connexion…" : !gatewayConnected ? "gateway déconnectée" : "connecté";
  const statusTone = wsState === "open" && gatewayConnected ? "text-emerald-400" : "text-amber-400";

  return (
    <div className="flex h-[70vh] flex-col rounded-lg border border-white/10 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <h2 className="text-sm font-medium text-neutral-300">Chat OpenClaw</h2>
        <span className={`text-xs ${statusTone}`}>{statusLabel}</span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Aucun message pour l'instant.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      <form
        className="flex gap-2 border-t border-white/10 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Écrire un message…"
          disabled={wsState !== "open"}
          className="flex-1 rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-white/30 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={wsState !== "open" || !draft.trim()}
          className="rounded-md bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
        >
          Envoyer
        </button>
      </form>
    </div>
  );
}
