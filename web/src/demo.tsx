// src/demo.tsx — banc de rendu des états du chat.
//
// Pourquoi ce fichier existe : le Mac mini n'a pas de session graphique, et
// beaucoup d'états de la conversation ne peuvent pas être produits à la
// demande sans solliciter l'agent réel (donc notifier l'opérateur sur son
// téléphone) — bloc de code, appel d'outil en erreur, raisonnement, réponse
// en streaming, échec d'envoi, message très long. Ce banc les rend tous à
// partir de données fixes, pour qu'ils soient vérifiables au pixel.
//
// Il n'est JAMAIS embarqué en production : Vite ne construit que `index.html`
// (voir `build.rollupOptions.input` par défaut), les autres pages HTML de la
// racine ne sont servies qu'en développement.
//
//   bun run demo        puis  http://127.0.0.1:5174/demo.html
//   bun scripts/demo-shots.ts   pour les captures automatiques

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "./components/ChatPanel";
import type { ChatController } from "./hooks/useChat";
import type { ChatMessage } from "./lib/chatTypes";
import "./index.css";

const T = Date.now() - 3 * 60_000;

function m(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "assistant",
    text: "",
    timestamp: T,
    pending: false,
    toolCalls: [],
    ...overrides,
  };
}

const MESSAGES: ChatMessage[] = [
  m({ id: "u1", role: "user", text: "Vérifie l'état des tests et montre-moi la commande.", timestamp: T }),

  m({
    id: "a1",
    timestamp: T + 2_000,
    reasoning:
      "L'opérateur veut deux choses : l'état réel des tests et la commande exacte.\n" +
      "Je lance la suite plutôt que de citer un chiffre de mémoire, puis je donne\n" +
      "la commande telle qu'elle doit être tapée.",
    text:
      "La suite est verte. Voici la commande :\n\n" +
      "```bash\nbun run check\n```\n\n" +
      "Elle enchaîne le typage, le lint, les tests et le build. Pour ne lancer\n" +
      "qu'un fichier :\n\n" +
      "```bash\nbun test src/gateway/client.test.ts\n```\n",
    toolCalls: [
      {
        id: "t1",
        name: "exec",
        title: "bun run check",
        phase: "result",
        startedAt: T + 2_000,
        durationMs: 5_230,
        exitCode: 0,
        output: "192 pass\n0 fail\n273 expect() calls\nRan 192 tests across 17 files.",
        args: { command: "bun run check", cwd: "/Users/claw/dev/clawdeck" },
        result: "ok",
      },
    ],
  }),

  m({ id: "u2", role: "user", text: "Et la config ?", timestamp: T + 20_000 }),

  m({
    id: "a2",
    timestamp: T + 22_000,
    text:
      "Extrait de configuration :\n\n" +
      "```json\n{\n  \"bindHost\": \"100.66.217.18\",\n  \"port\": 3001,\n  \"retentionDays\": 7\n}\n```\n\n" +
      "| Champ | Rôle |\n| --- | --- |\n| `bindHost` | interface d'écoute |\n| `port` | port TCP |\n\n" +
      "Un bloc sans langage déclaré :\n\n```\nligne brute\n```\n",
  }),

  m({
    id: "u3",
    role: "user",
    text: "Message reçu depuis le téléphone.",
    timestamp: T + 40_000,
    origin: { channel: "whatsapp", senderName: "Alex" },
  }),

  m({
    id: "a3",
    timestamp: T + 42_000,
    text: "Un outil qui échoue, pour voir l'état d'erreur :",
    toolCalls: [
      {
        id: "t2",
        name: "exec",
        title: "bun run migrate",
        phase: "result",
        startedAt: T + 42_000,
        durationMs: 812,
        exitCode: 1,
        isError: true,
        output: "error: table « pings » introuvable\n  at db.ts:41",
        result: "échec",
      },
      {
        id: "t3",
        name: "read_file",
        phase: "start",
        startedAt: T + 43_000,
      },
    ],
  }),

  m({
    id: "u4",
    role: "user",
    text: "Celui-ci a échoué à l'envoi.",
    timestamp: T + 60_000,
    clientMessageId: "c4",
    sendState: "failed",
    error: "connexion au relais perdue pendant l'envoi",
  }),

  m({
    id: "a4",
    timestamp: T + 62_000,
    pending: true,
    reasoning: "Je rassemble les éléments avant de répondre…",
    text: "Je suis en train d'écrire cette réponse, le curseur doit clignoter à la fin",
  }),
];

// Contrôleur factice : mêmes champs que useChat, aucune connexion réseau.
const chat: ChatController = {
  messages: MESSAGES,
  wsState: "open",
  gatewayConnected: true,
  deliveryRoute: { channel: "whatsapp", to: "+33769506360", accountId: "default" },
  activity: [
    {
      runId: "r-demo",
      own: false,
      startedAt: Date.now() - 12_000,
      lastEventAt: Date.now(),
      tool: { name: "exec", phase: "start" },
      waitingApproval: false,
    },
  ],
  rejectedToken: null,
  activeRunId: "r-demo",
  abortPending: false,
  abortError: null,
  send: () => true,
  retry: () => true,
  abort: () => true,
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <h1 className="mb-4 text-lg font-semibold tracking-tight sm:text-3xl">Banc de rendu — chat</h1>
      <ChatPanel chat={chat} active />
    </main>
  </StrictMode>,
);
