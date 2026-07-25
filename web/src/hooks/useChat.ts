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
  type DeliveryRoute,
  type GatewayConnectionState,
  type MessageModel,
  type MessageOrigin,
  type RunActivity,
  type ToolCall,
  type ToolCallPhase,
} from "../lib/chatTypes";
import { mergeHistory } from "../lib/historyMerge";

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

// Provenance d'un message tel qu'OpenClaw l'a enregistré. Deux conditions
// exigées, pas une : un canal externe ET une identité d'expéditeur (les
// messages WhatsApp portent senderId/senderName/senderE164). Le dashboard
// épingle `originatingChannel: whatsapp` sur ses propres envois pour que la
// réponse reparte sur le téléphone — si la gateway en dérive un
// `sourceChannel`, le seul critère du canal étiquetterait « via WhatsApp »
// des messages écrits ICI. L'identité d'expéditeur, elle, n'existe que pour
// un message réellement reçu d'une personne sur un canal.
function parseOrigin(m: Record<string, unknown>): MessageOrigin | undefined {
  const channel = asString(m.sourceChannel);
  if (!channel || channel === "webchat") return undefined;
  const senderName = asString(m.senderName) ?? asString(m.senderLabel);
  const hasSenderIdentity = Boolean(senderName ?? asString(m.senderE164) ?? asString(m.senderId));
  if (!hasSenderIdentity) return undefined;
  return { channel, ...(senderName ? { senderName } : {}) };
}

// Provider/modèle réellement utilisés, portés par chaque message d'historique.
// `openclaw/delivery-mirror` n'est PAS un modèle : c'est le marqueur d'un
// message recopié depuis un autre canal. L'afficher ferait croire à une
// génération qui n'a jamais eu lieu.
function parseModel(m: Record<string, unknown>): MessageModel | undefined {
  const provider = asString(m.provider);
  const name = asString(m.model);
  if (!provider || !name) return undefined;
  if (provider === "openclaw" || name === "delivery-mirror") return undefined;
  return { provider, name };
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
      ...(role === "user" ? { origin: parseOrigin(m) } : { model: parseModel(m) }),
    });
  });
  return out;
}

// Borne de sécurité sur la sortie d'une commande. La gateway borne déjà, mais
// une session `exec` bavarde ne doit pas pouvoir gonfler indéfiniment l'état
// React ni le rendu : on garde la FIN, celle qui porte le résultat.
const MAX_TOOL_OUTPUT_CHARS = 4_000;

function capOutput(text: string): string {
  return text.length <= MAX_TOOL_OUTPUT_CHARS
    ? text
    : `… début tronqué\n${text.slice(-MAX_TOOL_OUTPUT_CHARS)}`;
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
  // Route de livraison annoncée par le backend : null = la réponse restera
  // dans la session sans repartir sur un canal externe.
  const [deliveryRoute, setDeliveryRoute] = useState<DeliveryRoute | null>(null);
  // Token refusé par le backend (fermeture 1008) : App purge alors le token
  // stocké, via la même garde que le flux SSE (useStatusStream.rejectedToken).
  const [rejectedToken, setRejectedToken] = useState<string | null>(null);
  // Run assistant en cours (accusé send-ok ou streaming observé) : cible du
  // bouton « Interrompre ».
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [abortPending, setAbortPending] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  // Runs en cours, y compris ceux qu'on n'a PAS initiés (message WhatsApp,
  // tâche planifiée) : c'est tout l'intérêt du bandeau d'activité, ces
  // runs-là n'ont aucune trace visible tant que leur réponse n'arrive pas.
  const [activity, setActivity] = useState<RunActivity[]>([]);
  // runIds accusés par send-ok : distingue « votre demande » d'un run externe.
  const ownRunIds = useRef(new Set<string>());
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

  // Crée ou rafraîchit l'entrée d'activité d'un run. Toute mise à jour vaut
  // signe de vie : lastEventAt sert au bandeau à écarter un run dont plus
  // rien n'arrive (gateway coupée en plein run) plutôt que de l'afficher
  // « en cours » indéfiniment.
  const touchRun = useCallback((runId: string, patch: Partial<RunActivity>) => {
    setActivity((prev) => {
      const now = Date.now();
      const index = prev.findIndex((r) => r.runId === runId);
      if (index === -1) {
        return [
          ...prev,
          {
            runId,
            own: ownRunIds.current.has(runId),
            startedAt: now,
            lastEventAt: now,
            tool: null,
            waitingApproval: false,
            ...patch,
          },
        ];
      }
      const next = prev.slice();
      next[index] = { ...next[index]!, lastEventAt: now, own: ownRunIds.current.has(runId), ...patch };
      return next;
    });
  }, []);

  // Run terminé : il sort du bandeau, sa trace reste dans la conversation.
  const endRun = useCallback((runId: string) => {
    setActivity((prev) => prev.filter((r) => r.runId !== runId));
    ownRunIds.current.delete(runId);
  }, []);

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
        touchRun(runId, {});
      } else if (state === "final" || state === "aborted" || state === "error") {
        setActiveRunId((prev) => (prev === runId ? null : prev));
        endRun(runId);
      }
    },
    [upsertAssistantMessage, touchRun, endRun],
  );

  const handleAgentEvent = useCallback(
    (payload: unknown) => {
      const p = asRecord(payload);
      // Battement de cœur : preuve de liaison, pas d'activité de l'agent.
      if (!p || p.isHeartbeat === true) return;
      const runId = asString(p.runId);
      if (!runId) return;

      // Flux `approval` : le run est SUSPENDU tant que l'autorisation manque.
      // État bloquant, donc le plus utile à rendre visible — sans lui, un run
      // en attente est indiscernable d'un run qui travaille.
      if (p.stream === "approval") {
        touchRun(runId, { waitingApproval: true });
        return;
      }
      // Flux `thinking` : raisonnement de l'agent, envoyé cumulé (`text`) avec
      // son incrément (`delta`). On garde le cumulé, seul état complet même si
      // un incrément s'est perdu.
      if (p.stream === "thinking") {
        const data = asRecord(p.data);
        const text = asString(data?.text);
        if (!text) return;
        upsertAssistantMessage(runId, (msg) => ({ ...msg, reasoning: text }));
        touchRun(runId, {});
        return;
      }

      // Flux `command_output` : sortie live d'une commande, rattachée à son
      // appel d'outil. C'est ce qui permet de suivre un `exec` long sans
      // attendre son résultat final.
      if (p.stream === "command_output") {
        const data = asRecord(p.data);
        const toolCallId = asString(data?.toolCallId);
        if (!data || !toolCallId) return;
        const output = asString(data.output);
        const title = asString(data.title);
        const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
        const durationMs = typeof data.durationMs === "number" ? data.durationMs : undefined;
        upsertAssistantMessage(runId, (msg) => ({
          ...msg,
          toolCalls: msg.toolCalls.map((tool) =>
            tool.id === toolCallId
              ? {
                  ...tool,
                  ...(output ? { output: capOutput(output) } : {}),
                  ...(title ? { title } : {}),
                  ...(exitCode !== undefined ? { exitCode } : {}),
                  ...(durationMs !== undefined ? { durationMs } : {}),
                }
              : tool,
          ),
        }));
        touchRun(runId, {});
        return;
      }

      if (p.stream !== "tool") return;
      const data = asRecord(p.data);
      if (!data) return;

      const phase: ToolCallPhase =
        data.phase === "result" ? "result" : data.phase === "update" ? "update" : "start";
      const toolName = asString(data.name) ?? "outil";
      // Un événement d'outil vaut reprise : si une autorisation bloquait le
      // run, elle vient d'être accordée.
      touchRun(runId, { tool: { name: toolName, phase }, waitingApproval: false });

      const toolCallId = asString(data.toolCallId);
      if (!toolCallId) return;

      upsertAssistantMessage(runId, (msg) => {
        const existing = msg.toolCalls.find((t) => t.id === toolCallId);
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
    [upsertAssistantMessage, touchRun],
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
            // Message venu d'ailleurs (le téléphone) : sa provenance est
            // affichée, sinon rien ne distingue ce que J'AI écrit ici de ce
            // que j'ai écrit sur WhatsApp.
            ...(role === "user" ? { origin: parseOrigin(m) } : { model: parseModel(m) }),
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
            if (!frame.connected) {
              setActiveRunId(null);
              // Gateway perdue : la route connue ne vaut plus rien, ne pas
              // laisser le composeur promettre une livraison WhatsApp, ni le
              // bandeau affirmer qu'un run est toujours en cours.
              setDeliveryRoute(null);
              setActivity([]);
            }
            break;
          case "delivery-route":
            setDeliveryRoute(frame.route);
            break;
          case "history":
            // Fusion et non remplacement : la frame `history` arrive aussi
            // après une RECONNEXION, alors que le transcript contient déjà des
            // messages. L'ignorer dans ce cas laissait invisible, jusqu'au
            // rechargement complet, tout ce qui était arrivé pendant la
            // coupure — exactement ce qu'on veut voir en revenant.
            setMessages((prev) => capMessages(mergeHistory(prev, parseHistory(frame.messages))));
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
            if (frame.runId) {
              setActiveRunId(frame.runId);
              // Ce run est le nôtre : le bandeau le dira « votre demande »
              // plutôt que de le présenter comme une activité externe.
              ownRunIds.current.add(frame.runId);
              touchRun(frame.runId, { own: true });
            }
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
        setDeliveryRoute(null);
        setActivity([]);
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
  }, [token, handleChatEvent, handleAgentEvent, handleSessionMessage, touchRun, capMessages]);

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
    deliveryRoute,
    rejectedToken,
    activeRunId,
    activity,
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
