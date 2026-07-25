// src/lib/chatTypes.ts — modèle normalisé pour l'UI de chat, distinct du
// format brut de la gateway OpenClaw (verbeux, non garanti stable — voir
// hooks/useChat.ts qui fait la traduction).

// Miroir de MAX_CHAT_TEXT_LENGTH (src/validate.ts) : le backend refuse
// au-delà. Le composeur avertit AVANT d'envoyer plutôt que de laisser
// l'utilisateur découvrir la limite sur un échec.
export const MAX_CHAT_TEXT_LENGTH = 8_000;

export type ToolCallPhase = "start" | "update" | "result";

export interface ToolCall {
  id: string;
  name: string;
  phase: ToolCallPhase;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt: number;
  // Flux `command_output` : sortie de commande, envoyée cumulée et déjà bornée
  // par la gateway. Remplacée à chaque événement, jamais concaténée — la
  // concaténer dupliquerait tout ce qui précède.
  output?: string;
  // Renseignés à la fin d'une commande : le résultat opérationnel qui
  // intéresse vraiment quand on supervise une machine.
  exitCode?: number;
  durationMs?: number;
  // Titre lisible calculé par OpenClaw (ex. la commande réelle), plus parlant
  // que le nom d'outil brut.
  title?: string;
}

// Cycle d'accusé d'un envoi initié depuis CE dashboard : « sending » tant que
// le backend n'a pas répondu, « sent » sur send-ok (ou écho de session reçu),
// « failed » sur send-error. Absent pour l'historique, les messages venus
// d'ailleurs (WhatsApp…) et les réponses de l'assistant.
export type SendState = "sending" | "sent" | "failed";

// Canal par lequel un message est ENTRÉ dans la session (sourceChannel côté
// OpenClaw). Absent pour tout ce qui vient d'ici ou de la session elle-même :
// seul un message venu d'ailleurs (téléphone…) porte cette provenance.
export interface MessageOrigin {
  channel: string;
  senderName?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  pending: boolean;
  toolCalls: ToolCall[];
  error?: string;
  // Id local d'envoi, corrélé aux frames send-ok/send-error du backend.
  clientMessageId?: string;
  sendState?: SendState;
  origin?: MessageOrigin;
  // Flux `thinking` : raisonnement de l'agent, texte cumulatif. Replié par
  // défaut — c'est un éclairage sur le POURQUOI d'une action, pas la réponse.
  reasoning?: string;
}

// Activité d'un run de l'agent, reconstruite depuis les événements `agent`
// (enveloppe { runId, stream, ts, data }) et `chat`. Sert le bandeau
// d'activité : ce qu'OpenClaw fait MAINTENANT, y compris pour un run qu'on
// n'a pas initié (message WhatsApp, tâche planifiée) — invisible autrement.
export interface RunActivity {
  runId: string;
  // Initié depuis ce dashboard (runId accusé par send-ok).
  own: boolean;
  startedAt: number;
  lastEventAt: number;
  // Dernier outil signalé par le flux `tool` (null avant le premier).
  tool: { name: string; phase: ToolCallPhase } | null;
  // Flux `approval` : le run est bloqué tant qu'une autorisation manque.
  waitingApproval: boolean;
}

// Route de livraison épinglée par le backend sur chaque envoi (voir
// gateway/client.ts) : null = aucune route externe connue, la réponse
// restera dans la session sans repartir sur le téléphone.
export interface DeliveryRoute {
  channel: string;
  to: string;
  accountId?: string;
}

// « unauthorized » : fermeture WS 1008 (token refusé) — état d'auth définitif,
// aucune retentative tant que le token n'a pas changé.
export type GatewayConnectionState = "connecting" | "open" | "closed" | "unauthorized";

// Frames backend → navigateur du relais /api/chat/ws. Les payloads gateway
// (chat/agent/session-message, historique) restent `unknown` : leur forme
// n'est pas garantie stable, le narrowing se fait dans useChat.
export type ServerFrame =
  | { type: "auth-ok" }
  | { type: "gateway-status"; connected: boolean; error?: string }
  | { type: "history"; messages: unknown }
  | { type: "chat"; payload: unknown }
  | { type: "agent"; payload: unknown }
  | { type: "session-message"; payload: unknown }
  | { type: "delivery-route"; route: DeliveryRoute | null }
  | { type: "send-ok"; clientMessageId: string; runId?: string }
  | { type: "send-error"; clientMessageId: string; message: string }
  | { type: "abort-ok" }
  | { type: "abort-error"; message: string }
  | { type: "error"; message: string };

// Parse et valide une frame serveur. Retourne null pour tout ce qui est
// malformé ou inconnu : un backend plus récent peut introduire de nouvelles
// frames, un vieux front doit les ignorer silencieusement (et réciproquement).
export function parseServerFrame(raw: string): ServerFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const frame = data as Record<string, unknown>;
  const type = frame.type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "auth-ok":
      return { type: "auth-ok" };
    case "gateway-status":
      return {
        type: "gateway-status",
        connected: frame.connected === true,
        ...(typeof frame.error === "string" ? { error: frame.error } : {}),
      };
    case "history":
      return { type: "history", messages: frame.messages };
    case "chat":
      return { type: "chat", payload: frame.payload };
    case "agent":
      return { type: "agent", payload: frame.payload };
    case "session-message":
      return { type: "session-message", payload: frame.payload };
    case "delivery-route": {
      // Route incomplète ou absente → null explicite : « aucune route
      // externe », état affiché tel quel plutôt que passé sous silence.
      const raw = frame.route;
      const route =
        raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      if (typeof route?.channel !== "string" || typeof route.to !== "string" || !route.channel || !route.to) {
        return { type: "delivery-route", route: null };
      }
      return {
        type: "delivery-route",
        route: {
          channel: route.channel,
          to: route.to,
          ...(typeof route.accountId === "string" ? { accountId: route.accountId } : {}),
        },
      };
    }
    case "send-ok":
      if (typeof frame.clientMessageId !== "string") return null;
      return {
        type: "send-ok",
        clientMessageId: frame.clientMessageId,
        ...(typeof frame.runId === "string" ? { runId: frame.runId } : {}),
      };
    case "send-error":
      if (typeof frame.clientMessageId !== "string") return null;
      return {
        type: "send-error",
        clientMessageId: frame.clientMessageId,
        message: typeof frame.message === "string" ? frame.message : "échec de l'envoi",
      };
    case "abort-ok":
      return { type: "abort-ok" };
    case "abort-error":
      return {
        type: "abort-error",
        message: typeof frame.message === "string" ? frame.message : "interruption impossible",
      };
    case "error":
      if (typeof frame.message !== "string") return null;
      return { type: "error", message: frame.message };
    default:
      return null;
  }
}
