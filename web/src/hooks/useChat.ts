// src/hooks/useChat.ts — connexion WS vers notre backend (/api/chat/ws), qui
// relaie lui-même la gateway OpenClaw. Traduit le flux brut (chat/agent
// events, cf. src/gateway/client.ts côté backend) en modèle normalisé
// ChatMessage/ToolCall pour l'UI.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, GatewayConnectionState, ToolCall } from "../lib/chatTypes";

// crypto.randomUUID() exige un contexte sécurisé (HTTPS ou localhost) — le
// dashboard est servi en http:// sur l'IP Tailscale, donc indisponible ici ;
// un ID local suffit, pas besoin d'unicité cryptographique.
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Fenêtres de réconciliation du miroir de session (handleSessionMessage).
// Au-delà, un texte identique est un nouveau message légitime, pas un écho.
const LOCAL_ECHO_WINDOW_MS = 2 * 60_000; // écho de l'envoi optimiste du dashboard
const ASSISTANT_ECHO_WINDOW_MS = 30_000; // doublon d'une réponse déjà streamée sans runId

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/chat/ws`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && (block as any).type === "text" ? (block as any).text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function parseHistory(raw: unknown): ChatMessage[] {
  const messages = (raw as any)?.messages;
  if (!Array.isArray(messages)) return [];

  const out: ChatMessage[] = [];
  messages.forEach((m, i) => {
    if (m?.role !== "user" && m?.role !== "assistant") return;
    const text = extractText(m.content);
    if (!text) return;
    out.push({
      id: `history-${i}-${m.timestamp ?? i}`,
      role: m.role,
      text,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      pending: false,
      toolCalls: [],
    });
  });
  return out;
}

export function useChat(token: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [wsState, setWsState] = useState<GatewayConnectionState>("connecting");
  const [gatewayConnected, setGatewayConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const runIdToMessageId = useRef(new Map<string, string>());

  const upsertAssistantMessage = useCallback((runId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      let id = runIdToMessageId.current.get(runId);
      if (!id) {
        id = `run-${runId}`;
        runIdToMessageId.current.set(runId, id);
        return [
          ...prev,
          updater({ id, role: "assistant", text: "", timestamp: Date.now(), pending: true, toolCalls: [] }),
        ];
      }
      return prev.map((m) => (m.id === id ? updater(m) : m));
    });
  }, []);

  const handleChatEvent = useCallback(
    (payload: any) => {
      const runId = payload.runId;
      if (!runId) return;
      upsertAssistantMessage(runId, (msg) => {
        const text = extractText(payload.message?.content) || msg.text;
        if (payload.state === "delta") {
          return { ...msg, text, pending: true };
        }
        if (payload.state === "final") {
          return { ...msg, text, pending: false };
        }
        if (payload.state === "aborted") {
          return { ...msg, text, pending: false, error: "interrompu" };
        }
        if (payload.state === "error") {
          return { ...msg, text, pending: false, error: payload.errorMessage ?? "erreur" };
        }
        return msg;
      });
    },
    [upsertAssistantMessage],
  );

  const handleAgentEvent = useCallback(
    (payload: any) => {
      if (payload.stream !== "tool") return;
      const runId = payload.runId;
      const toolCallId = payload.data?.toolCallId;
      if (!runId || !toolCallId) return;

      upsertAssistantMessage(runId, (msg) => {
        const existing = msg.toolCalls.find((t) => t.id === toolCallId);
        const phase = payload.data.phase === "result" ? "result" : payload.data.phase === "update" ? "update" : "start";
        const next: ToolCall = {
          id: toolCallId,
          name: payload.data.name ?? existing?.name ?? "outil",
          phase,
          args: payload.data.args ?? existing?.args,
          result: payload.data.result ?? existing?.result,
          isError: payload.data.isError ?? existing?.isError,
          startedAt: existing?.startedAt ?? payload.ts ?? Date.now(),
        };
        const toolCalls = existing
          ? msg.toolCalls.map((t) => (t.id === toolCallId ? next : t))
          : [...msg.toolCalls, next];
        return { ...msg, toolCalls };
      });
    },
    [upsertAssistantMessage],
  );

  // Miroir live : messages ajoutés à la session côté gateway (WhatsApp entrant
  // depuis le téléphone, réponses initiées ailleurs). Source de vérité du
  // transcript. L'écho de l'envoi optimiste (user) est réconcilié avec son
  // message local-* ; le doublon du streaming (assistant, déjà affiché via
  // les events chat/agent) est écarté — de façon ciblée seulement, pour ne
  // jamais supprimer deux vrais messages identiques envoyés à des moments
  // différents.
  const handleSessionMessage = useCallback((payload: any) => {
    const m = payload?.message ?? payload;
    const role = m?.role;
    if (role !== "user" && role !== "assistant") return;
    const text = extractText(m.content);
    const trimmed = text.trim();
    if (!trimmed) return;

    const runId = payload?.runId ?? m?.runId;
    const stableId = m?.__openclaw?.id ?? `sess-${role}-${m?.timestamp ?? Date.now()}`;

    setMessages((prev) => {
      if (prev.some((x) => x.id === stableId)) return prev;
      if (runId && prev.some((x) => x.id === `run-${runId}`)) return prev;

      const now = Date.now();

      if (role === "user") {
        // Écho de l'envoi optimiste du dashboard : on réconcilie le message
        // local-* correspondant (le plus récent, même texte, encore dans la
        // fenêtre) au lieu d'ajouter un doublon. Son id devient le stableId
        // serveur : il ne pourra plus absorber un autre écho.
        for (let i = prev.length - 1; i >= 0; i--) {
          const x = prev[i];
          if (
            x.role === "user" &&
            x.id.startsWith("local-") &&
            x.text.trim() === trimmed &&
            now - x.timestamp <= LOCAL_ECHO_WINDOW_MS
          ) {
            const next = prev.slice();
            next[i] = { ...x, id: stableId, timestamp: typeof m.timestamp === "number" ? m.timestamp : x.timestamp };
            return next;
          }
        }
        // Pas de candidat : message venu d'ailleurs (WhatsApp…), ajout normal.
      } else if (!runId) {
        // Assistant sans runId : impossible de le relier à un message run-*.
        // On n'écarte que le doublon d'une réponse récente (encore en cours
        // de streaming ou finalisée il y a peu) — jamais contre toute la
        // conversation, sinon deux réponses identiques espacées seraient
        // silencieusement perdues.
        const isStreamEcho = prev.some(
          (x) =>
            x.role === "assistant" &&
            x.text.trim() === trimmed &&
            (x.pending || now - x.timestamp <= ASSISTANT_ECHO_WINDOW_MS),
        );
        if (isStreamEcho) return prev;
      }

      return [
        ...prev,
        {
          id: stableId,
          role,
          text,
          timestamp: typeof m.timestamp === "number" ? m.timestamp : now,
          pending: false,
          toolCalls: [],
        },
      ];
    });
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      setWsState("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token }));
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        switch (msg.type) {
          case "auth-ok":
            setWsState("open");
            break;
          case "gateway-status":
            setGatewayConnected(!!msg.connected);
            break;
          case "history":
            setMessages((prev) => (prev.length === 0 ? parseHistory(msg.messages) : prev));
            break;
          case "chat":
            handleChatEvent(msg.payload);
            break;
          case "agent":
            handleAgentEvent(msg.payload);
            break;
          case "session-message":
            handleSessionMessage(msg.payload);
            break;
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setWsState("closed");
        setGatewayConnected(false);
        retryTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [token, handleChatEvent, handleAgentEvent, handleSessionMessage]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || wsRef.current?.readyState !== WebSocket.OPEN || !gatewayConnected) return false;
    setMessages((prev) => [
      ...prev,
      { id: `local-${localId()}`, role: "user", text: trimmed, timestamp: Date.now(), pending: false, toolCalls: [] },
    ]);
    wsRef.current.send(JSON.stringify({ type: "send", text: trimmed }));
    return true;
  }, [gatewayConnected]);

  return { messages, wsState, gatewayConnected, send };
}
