// src/lib/chatTypes.ts — modèle normalisé pour l'UI de chat, distinct du
// format brut de la gateway OpenClaw (verbeux, non garanti stable — voir
// hooks/useChat.ts qui fait la traduction).

export type ToolCallPhase = "start" | "update" | "result";

export interface ToolCall {
  id: string;
  name: string;
  phase: ToolCallPhase;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  pending: boolean;
  toolCalls: ToolCall[];
  error?: string;
}

export type GatewayConnectionState = "connecting" | "open" | "closed";
