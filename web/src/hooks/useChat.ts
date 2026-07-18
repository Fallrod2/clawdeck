// src/hooks/useChat.ts — connexion WS vers notre backend (/api/chat/ws), qui
// relaie lui-même la gateway OpenClaw. Traduit le flux brut (chat/agent
// events, cf. src/gateway/client.ts côté backend) en modèle normalisé
// ChatMessage/ToolCall pour l'UI. Frontières typées : chaque frame serveur
// passe par parseServerFrame, les payloads gateway restent `unknown` et sont
// réduits ici par narrowing.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseServerFrame,
  type ChatMessage,
  type GatewayConnectionState,
  type ToolCall,
} from "../lib/chatTypes";

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

// Cap glissant du transcript en mémoire, aligné sur celui des logs (500).
// Un message non réconcilié (envoi en cours ou échoué, réponse encore en
// streaming) n'est JAMAIS purgé, quitte à dépasser temporairement le cap.
const MAX_MESSAGES = 500;

// Reconnexion au relais : backoff exponentiel 1 s → 30 s, remis à zéro sur
// auth-ok ; relance immédiate quand le réseau revient (online) ou que
// l'onglet redevient visible — bornée et non bruyante (UI_UX §6).
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/chat/ws`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = asRecord(block);
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("");
}

function parseHistory(raw: unknown): ChatMessage[] {
  const messages = asRecord(raw)?.messages;
  if (!Array.isArray(messages)) return [];

  const out: ChatMessage[] = [];
  messages.forEach((entry, i) => {
    const m = asRecord(entry);
    if (!m) return;
    const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null;
    if (!role) return;
    const text = extractText(m.content);
    if (!text) return;
    out.push({
      id: `history-${i}-${typeof m.timestamp === "number" ? m.timestamp : i}`,
      role,
      text,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      pending: false,
      toolCalls: [],
    });
  });
  return out;
}

// Un message encore « ouvert » (accusé ou réconciliation attendus) survit au
// cap glissant.
function isSettling(m: ChatMessage): boolean {
  return m.pending || m.sendState === "sending" || m.sendState === "failed";
}

export function useChat(token: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [wsState, setWsState] = useState<GatewayConnectionState>("connecting");
  const [gatewayConnected, setGatewayConnected] = useState(false);
  // Token refusé par le backend (fermeture 1008) : App purge alors le token
  // stocké, via la même garde que le flux SSE (useStatusStream.rejectedToken).
  const [rejectedToken, setRejectedToken] = useState<string | null>(null);
  // Run assistant en cours (accusé send-ok ou streaming observé) : cible du
  // bouton « Interrompre ».
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [abortPending, setAbortPending] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const runIdToMessageId = useRef(new Map<string, string>());
  // Miroir de l'état courant pour retry() : évite de recréer le callback à
  // chaque message reçu.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Cap glissant : retire les plus anciens messages réconciliés au-delà de
  // MAX_MESSAGES, puis purge l'index runId → message des entrées orphelines
  // (un message sorti du cap ne recevra plus jamais de mise à jour).
  const capMessages = useCallback((list: ChatMessage[]): ChatMessage[] => {
    if (list.length <= MAX_MESSAGES) return list;
    let excess = list.length - MAX_MESSAGES;
    const capped = list.filter((m) => {
      if (excess <= 0 || isSettling(m)) return true;
      excess -= 1;
      return false;
    });
    if (capped.length !== list.length) {
      const kept = new Set(capped.map((m) => m.id));
      for (const [runId, id] of runIdToMessageId.current) {
        if (!kept.has(id)) runIdToMessageId.current.delete(runId);
      }
    }
    return capped;
  }, []);

  const upsertAssistantMessage = useCallback(
    (runId: string, updater: (msg: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        let id = runIdToMessageId.current.get(runId);
        if (!id) {
          id = `run-${runId}`;
          runIdToMessageId.current.set(runId, id);
          return capMessages([
            ...prev,
            updater({ id, role: "assistant", text: "", timestamp: Date.now(), pending: true, toolCalls: [] }),
          ]);
        }
        return prev.map((m) => (m.id === id ? updater(m) : m));
      });
    },
    [capMessages],
  );

  const handleChatEvent = useCallback(
    (payload: unknown) => {
      const p = asRecord(payload);
      const runId = asString(p?.runId);
      if (!p || !runId) return;
      const state = p.state;
      const eventText = extractText(asRecord(p.message)?.content);
      upsertAssistantMessage(runId, (msg) => {
        const text = eventText || msg.text;
        if (state === "delta") {
          return { ...msg, text, pending: true };
        }
        // États terminaux : timestamp ramené à MAINTENANT, pas au début du
        // streaming — la fenêtre anti-doublon de handleSessionMessage court
        // depuis la fin de la réponse, sinon toute réponse ayant streamé
        // plus de 30 s était dupliquée par son écho de session (constaté en
        // prod le 2026-07-18).
        if (state === "final") {
          return { ...msg, text, pending: false, timestamp: Date.now() };
        }
        if (state === "aborted") {
          return { ...msg, text, pending: false, timestamp: Date.now(), error: "interrompu" };
        }
        if (state === "error") {
          return {
            ...msg,
            text,
            pending: false,
            timestamp: Date.now(),
            error: asString(p.errorMessage) ?? "erreur",
          };
        }
        return msg;
      });
      // Suivi du run actif pour « Interrompre » : un delta le désigne (même
      // pour un run initié hors dashboard), un état terminal le libère.
      if (state === "delta") {
        setActiveRunId(runId);
      } else if (state === "final" || state === "aborted" || state === "error") {
        setActiveRunId((prev) => (prev === runId ? null : prev));
      }
    },
    [upsertAssistantMessage],
  );

  const handleAgentEvent = useCallback(
    (payload: unknown) => {
      const p = asRecord(payload);
      if (!p || p.stream !== "tool") return;
      const runId = asString(p.runId);
      const data = asRecord(p.data);
      const toolCallId = asString(data?.toolCallId);
      if (!runId || !data || !toolCallId) return;

      upsertAssistantMessage(runId, (msg) => {
        const existing = msg.toolCalls.find((t) => t.id === toolCallId);
        const phase = data.phase === "result" ? "result" : data.phase === "update" ? "update" : "start";
        const next: ToolCall = {
          id: toolCallId,
          name: asString(data.name) ?? existing?.name ?? "outil",
          phase,
          args: data.args ?? existing?.args,
          result: data.result ?? existing?.result,
          isError: typeof data.isError === "boolean" ? data.isError : existing?.isError,
          startedAt: existing?.startedAt ?? (typeof p.ts === "number" ? p.ts : Date.now()),
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
  const handleSessionMessage = useCallback(
    (payload: unknown) => {
      const p = asRecord(payload);
      if (!p) return;
      const m = asRecord(p.message) ?? p;
      const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null;
      if (!role) return;
      const text = extractText(m.content);
      const trimmed = text.trim();
      if (!trimmed) return;

      const runId = asString(p.runId) ?? asString(m.runId);
      const stableId =
        asString(asRecord(m.__openclaw)?.id) ??
        `sess-${role}-${typeof m.timestamp === "number" ? m.timestamp : Date.now()}`;

      setMessages((prev) => {
        if (prev.some((x) => x.id === stableId)) return prev;
        if (runId && prev.some((x) => x.id === `run-${runId}`)) return prev;

        const now = Date.now();

        if (role === "user") {
          // Écho de l'envoi optimiste du dashboard : on réconcilie le message
          // local-* correspondant (le plus récent, même texte, encore dans la
          // fenêtre) au lieu d'ajouter un doublon. Son id devient le stableId
          // serveur : il ne pourra plus absorber un autre écho. L'écho vaut
          // preuve de livraison : il confirme aussi un envoi resté sans accusé,
          // voire marqué en échec (timeout RPC dont le message est finalement
          // passé côté gateway).
          for (let i = prev.length - 1; i >= 0; i--) {
            const x = prev[i];
            if (
              x.role === "user" &&
              x.id.startsWith("local-") &&
              x.text.trim() === trimmed &&
              now - x.timestamp <= LOCAL_ECHO_WINDOW_MS
            ) {
              const next = prev.slice();
              next[i] = {
                ...x,
                id: stableId,
                timestamp: typeof m.timestamp === "number" ? m.timestamp : x.timestamp,
                ...(x.sendState ? { sendState: "sent" as const, error: undefined } : {}),
              };
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

        return capMessages([
          ...prev,
          {
            id: stableId,
            role,
            text,
            timestamp: typeof m.timestamp === "number" ? m.timestamp : now,
            pending: false,
            toolCalls: [],
          },
        ]);
      });
    },
    [capMessages],
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // 1008 = auth refusée : état définitif pour ce token, plus aucune
    // retentative (voir onclose).
    let unauthorized = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setRejectedToken(null);

    function scheduleRetry() {
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
      attempt += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    }

    // Les accusés ne voyagent que sur la connexion qui a porté l'envoi : tout
    // message encore « sending » quand elle disparaît ne sera jamais acquitté
    // → marqué en échec, re-tentable. (L'écho de session le repassera
    // « envoyé » si l'envoi avait malgré tout abouti côté gateway.)
    function failOrphanSends() {
      setMessages((prev) =>
        prev.some((msg) => msg.sendState === "sending")
          ? prev.map((msg) =>
              msg.sendState === "sending"
                ? { ...msg, sendState: "failed" as const, error: "connexion au relais perdue pendant l'envoi" }
                : msg,
            )
          : prev,
      );
    }

    // Relance immédiate (retour réseau, onglet redevenu visible) : seulement
    // si aucune connexion n'est déjà ouverte ou en cours.
    function retryNow() {
      if (cancelled || unauthorized) return;
      const current = wsRef.current;
      if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) {
        return;
      }
      clearTimeout(retryTimer);
      connect();
    }

    function connect() {
      if (cancelled || unauthorized) return;
      // Aucun envoi ne peut encore exister sur la connexion à naître : un
      // « sending » résiduel vient d'un socket abandonné dont le onclose a
      // été court-circuité (voir garde d'identité plus bas).
      failOrphanSends();
      setWsState("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token }));
      };

      ws.onmessage = (ev) => {
        // Un socket abandonné (relance immédiate pendant sa fermeture) ne
        // doit plus toucher l'état — même règle que côté GatewayClient.
        if (wsRef.current !== ws) return;
        const frame = parseServerFrame(typeof ev.data === "string" ? ev.data : "");
        // Frame malformée ou type inconnu (backend plus récent) : ignorée.
        if (!frame) return;

        switch (frame.type) {
          case "auth-ok":
            attempt = 0; // connexion aboutie : le backoff repart de sa base
            setWsState("open");
            break;
          case "gateway-status":
            setGatewayConnected(frame.connected);
            if (!frame.connected) setActiveRunId(null);
            break;
          case "history":
            setMessages((prev) => (prev.length === 0 ? parseHistory(frame.messages) : prev));
            break;
          case "chat":
            handleChatEvent(frame.payload);
            break;
          case "agent":
            handleAgentEvent(frame.payload);
            break;
          case "session-message":
            handleSessionMessage(frame.payload);
            break;
          case "send-ok":
            // Accusé du backend : le message optimiste passe « envoyé ». La
            // réconciliation par écho session-message reste la source de
            // vérité de l'id définitif — ici on ne touche qu'au sendState,
            // donc aucun doublon possible entre accusé et écho. Le runId
            // annoncé désigne la réponse en cours (cible d'« Interrompre »).
            setMessages((prev) =>
              prev.map((msg) =>
                msg.clientMessageId === frame.clientMessageId && msg.sendState === "sending"
                  ? { ...msg, sendState: "sent" }
                  : msg,
              ),
            );
            if (frame.runId) setActiveRunId(frame.runId);
            break;
          case "send-error":
            setMessages((prev) =>
              prev.map((msg) =>
                msg.clientMessageId === frame.clientMessageId && msg.sendState === "sending"
                  ? { ...msg, sendState: "failed", error: frame.message }
                  : msg,
              ),
            );
            break;
          case "abort-ok":
            // L'état « interrompu » du message arrivera par l'événement chat
            // (state aborted) : ici on ne fait que libérer le bouton.
            setAbortPending(false);
            break;
          case "abort-error":
            setAbortPending(false);
            setAbortError(frame.message);
            break;
          case "error":
            // Erreur générique sans clientMessageId (compat ancien
            // protocole) : rien à réconcilier côté UI.
            break;
        }
      };

      ws.onclose = (ev) => {
        // Fermeture tardive d'un socket déjà remplacé (retryNow a reconnecté
        // pendant le CLOSING) : ne pas écraser l'état de la connexion neuve
        // ni programmer une reconnexion parallèle.
        if (cancelled || wsRef.current !== ws) return;
        setGatewayConnected(false);
        setActiveRunId(null);
        setAbortPending(false);
        failOrphanSends();
        if (ev.code === 1008) {
          // Fermeture 1008 : token refusé ou auth expirée. C'est un état
          // d'auth, pas une coupure réseau — on ne retente pas.
          unauthorized = true;
          setRejectedToken(token);
          setWsState("unauthorized");
          return;
        }
        setWsState("closed");
        scheduleRetry();
      };
    }

    const onOnline = () => retryNow();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [token, handleChatEvent, handleAgentEvent, handleSessionMessage]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || wsRef.current?.readyState !== WebSocket.OPEN || !gatewayConnected) return false;
      const clientMessageId = localId();
      setMessages((prev) =>
        capMessages([
          ...prev,
          {
            id: `local-${clientMessageId}`,
            role: "user",
            text: trimmed,
            timestamp: Date.now(),
            pending: false,
            toolCalls: [],
            clientMessageId,
            sendState: "sending",
          },
        ]),
      );
      wsRef.current.send(JSON.stringify({ type: "send", text: trimmed, clientMessageId }));
      return true;
    },
    [gatewayConnected, capMessages],
  );

  // Re-tente un envoi marqué en échec : MÊME texte, NOUVEAU clientMessageId
  // (l'ancien peut encore recevoir un accusé tardif, il ne doit plus rien
  // cibler). Le message échoué est remplacé par un nouvel envoi optimiste en
  // fin de conversation — jamais supprimé sans successeur.
  const retry = useCallback(
    (clientMessageId: string) => {
      const failed = messagesRef.current.find(
        (m) => m.clientMessageId === clientMessageId && m.sendState === "failed",
      );
      if (!failed || wsRef.current?.readyState !== WebSocket.OPEN || !gatewayConnected) return false;
      const nextClientMessageId = localId();
      setMessages((prev) =>
        capMessages([
          ...prev.filter((m) => !(m.clientMessageId === clientMessageId && m.sendState === "failed")),
          {
            id: `local-${nextClientMessageId}`,
            role: "user",
            text: failed.text,
            timestamp: Date.now(),
            pending: false,
            toolCalls: [],
            clientMessageId: nextClientMessageId,
            sendState: "sending",
          },
        ]),
      );
      wsRef.current.send(
        JSON.stringify({ type: "send", text: failed.text, clientMessageId: nextClientMessageId }),
      );
      return true;
    },
    [gatewayConnected, capMessages],
  );

  // Demande d'interruption du run actif ; l'issue réelle arrive par abort-ok/
  // abort-error puis par l'état « aborted » du flux chat.
  const abort = useCallback(() => {
    if (!activeRunId || wsRef.current?.readyState !== WebSocket.OPEN) return false;
    setAbortPending(true);
    setAbortError(null);
    wsRef.current.send(JSON.stringify({ type: "abort", runId: activeRunId }));
    return true;
  }, [activeRunId]);

  return {
    messages,
    wsState,
    gatewayConnected,
    rejectedToken,
    activeRunId,
    abortPending,
    abortError,
    send,
    retry,
    abort,
  };
}

// Contrat consommé par ChatPanel : le hook vit désormais dans App pour que la
// connexion et le transcript survivent au changement d'onglet.
export type ChatController = ReturnType<typeof useChat>;
