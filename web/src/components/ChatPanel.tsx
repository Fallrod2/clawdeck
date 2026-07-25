// src/components/ChatPanel.tsx — conversation principale, streaming et outils.
// Le hook useChat vit dans App (la connexion doit survivre au changement
// d'onglet) : ce panneau ne fait qu'afficher son état et relayer ses actions.
//
// Parti pris de présentation : traitement ASYMÉTRIQUE des deux interlocuteurs.
// Les messages de l'opérateur sont courts — bulle compacte alignée à droite.
// Les réponses de l'agent contiennent du code, des tableaux et des appels
// d'outils — bloc pleine largeur adossé à un rail vertical qui porte leur
// état (en cours, interrompu, en erreur). Une bulle à 82 % de large écrasait
// ces contenus sans rien apporter.

import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import Markdown, { type Components } from "react-markdown";
// GFM : tableaux, listes de tâches et texte barré produits par l'agent —
// sans rehype-raw, le HTML reste échappé (pas de XSS).
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { ActivityStrip } from "./ActivityStrip";
import {
  MAX_CHAT_TEXT_LENGTH,
  type ChatMessage,
  type DeliveryRoute,
  type MessageMedia,
  type ToolCall,
} from "../lib/chatTypes";
import type { ChatController } from "../hooks/useChat";
import { buildTimeline, formatDayLabel, type MessageGroup } from "../lib/timeline";
import { ChatSearch, type ChatSearchHighlight } from "./ChatSearch";
import { getToken } from "../lib/token";

const REMARK_PLUGINS = [remarkGfm];

/** Brouillon conservé d'un rechargement à l'autre. */
const DRAFT_STORAGE_KEY = "clawdeck.chatDraft";
/** Le compteur de caractères n'apparaît qu'à l'approche de la limite. */
const COUNTER_REVEAL_RATIO = 0.8;
/** Hauteur maximale du composeur avant qu'il ne défile lui-même. */
const COMPOSER_MAX_HEIGHT_PX = 200;

// Amorces d'usage : volontairement opérationnelles et propres à ce produit.
// Des suggestions génériques n'apprendraient rien de ce que cet agent-là sait
// faire. Un clic REMPLIT le composeur sans envoyer : l'agent agit sur une
// vraie machine, la dernière relecture appartient à l'opérateur.
const STARTERS = [
  "Quel est ton statut ?",
  "Qu'as-tu fait aujourd'hui ?",
  "Résume les erreurs récentes",
  "Liste les fichiers de ton workspace",
];

function readStoredDraft(): string {
  try {
    return localStorage.getItem(DRAFT_STORAGE_KEY) ?? "";
  } catch {
    // Stockage indisponible (mode privé) : on démarre simplement à vide.
    return "";
  }
}

function storeDraft(value: string) {
  try {
    if (value) localStorage.setItem(DRAFT_STORAGE_KEY, value);
    else localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Brouillon non persisté : sans conséquence sur la session en cours.
  }
}

// Langage annoncé par la clôture markdown (```ts), lu sur la classe que
// react-markdown pose sur le <code> enfant. Sert d'orientation : le contenu
// n'est délibérément PAS colorisé (voir docs/EN-ATTENTE.md), le repère de
// langage apporte l'essentiel de ce que la coloration donnerait ici.
function readCodeLanguage(children: unknown): string | null {
  if (!isValidElement(children)) return null;
  const className = (children.props as { className?: unknown } | null)?.className;
  if (typeof className !== "string") return null;
  const found = className.split(/\s+/).find((c) => c.startsWith("language-"));
  const language = found?.slice("language-".length).trim();
  // Un « langage » invraisemblable (texte collé par erreur après les
  // backticks) ne doit pas devenir une étiquette illisible.
  return language && /^[\w+#.-]{1,16}$/.test(language) ? language : null;
}

// Bloc de code enrichi d'un en-tête : langage à gauche, copie à droite. Le
// texte est lu au clic depuis le DOM (textContent) plutôt que reconstruit
// depuis les nœuds markdown : c'est exactement ce que l'utilisateur voit,
// sauts de ligne compris.
function PreBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const language = readCodeLanguage(children);
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-black/35">
      <div className="flex min-h-8 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <span className="font-mono text-2xs uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {language ?? "texte"}
        </span>
        <CopyButton
          getText={() => ref.current?.textContent ?? ""}
          label="Copier le bloc de code"
          className="ml-auto opacity-0 group-hover/code:opacity-100"
        />
      </div>
      {/* Bordure et fond portés par le conteneur : le <pre> ne garde que le
          défilement horizontal, sinon on empilerait deux cadres. */}
      <pre {...props} ref={ref} className="!my-0 overflow-x-auto !rounded-none !border-0 !bg-transparent">
        {children}
      </pre>
    </div>
  );
}

// Constante de module : une nouvelle référence à chaque rendu forcerait
// react-markdown à tout reconstruire à chaque delta de streaming.
const MARKDOWN_COMPONENTS: Components = { pre: PreBlock };

// Noms de canaux OpenClaw → libellé humain. Un canal inconnu est affiché tel
// quel plutôt que masqué : mieux vaut un nom brut qu'une provenance perdue.
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  signal: "Signal",
  imessage: "iMessage",
  discord: "Discord",
  slack: "Slack",
  sms: "SMS",
  email: "E-mail",
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

// Fournisseurs qui signent un repli local plutôt que le modèle nominal. La
// liste reste courte et explicite : mieux vaut ne pas signaler un repli réel
// que d'en signaler un qui n'existe pas.
const FALLBACK_PROVIDERS = new Set(["ollama", "llamacpp", "lmstudio"]);

function isFallbackProvider(provider: string): boolean {
  return FALLBACK_PROVIDERS.has(provider.toLowerCase());
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function formatPayload(value: unknown): string | null {
  if (value == null) return null;
  const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!formatted) return null;
  return formatted.length > 8_000 ? `${formatted.slice(0, 8_000)}\n… contenu tronqué` : formatted;
}

// Raisonnement de l'agent (flux `thinking`). Replié par défaut : c'est un
// éclairage sur le POURQUOI d'une action, jamais la réponse elle-même. Le
// résumé montre la dernière ligne en cours d'écriture, ce qui donne la
// visibilité live sans imposer un pavé ni contrarier un repli manuel.
function ReasoningBlock({ text, live }: { text: string; live: boolean }) {
  const tail = text.trim().split("\n").filter(Boolean).pop() ?? "";
  return (
    <details className="clawdeck-enter group mb-2 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-black/20 text-xs">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-3 text-[var(--text-muted)] marker:content-none">
        <span className="shrink-0 text-2xs uppercase tracking-[0.12em]">Raisonnement</span>
        {/* Masqué une fois déplié : l'aperçu répéterait la dernière ligne du
            texte affiché juste en dessous. */}
        {live && (
          <span className="min-w-0 flex-1 truncate italic opacity-70 group-open:hidden">{tail}</span>
        )}
        <span className="ml-auto shrink-0 transition-transform group-open:rotate-180" aria-hidden>
          ⌄
        </span>
      </summary>
      <div className="border-t border-[var(--border-subtle)] px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-xs leading-6 text-[var(--text-secondary)]">{text}</p>
      </div>
    </details>
  );
}

// Un envoi sortant réussi de l'agent, extrait du résultat de l'outil
// `message`. C'est l'information la plus attendue de tout le panneau : après
// trois bugs de synchronisation WhatsApp, « est-ce que c'est VRAIMENT parti
// sur le téléphone ? » ne doit pas exiger de déplier un JSON.
function readOutboundMessage(tool: ToolCall): { channel: string; to: string } | null {
  if (tool.name !== "message" || tool.phase !== "result" || tool.isError) return null;
  const raw =
    typeof tool.result === "string"
      ? tool.result
      : typeof (tool.result as { content?: unknown } | null)?.content === "string"
        ? ((tool.result as { content: string }).content)
        : null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { channel?: unknown; to?: unknown };
    if (typeof parsed.channel !== "string" || typeof parsed.to !== "string") return null;
    return { channel: parsed.channel, to: parsed.to };
  } catch {
    // Forme inattendue : on retombe sur la carte d'outil ordinaire plutôt que
    // d'affirmer une livraison qu'on n'a pas su lire.
    return null;
  }
}

// Textes de remplacement posés par OpenClaw à la place d'un contenu qu'il ne
// peut pas retranscrire. Ce ne sont PAS les mots de l'utilisateur : les
// afficher tels quels mettait de l'anglais brut dans une interface française,
// et les faisait passer pour un message écrit. Correspondance exacte
// uniquement — hors de question de réécrire du contenu réel.
const SYSTEM_PLACEHOLDERS: Record<string, string> = {
  "[User sent media without caption]": "média envoyé, sans légende",
  "[Image]": "image envoyée",
  "[Audio]": "message vocal envoyé",
  "[Video]": "vidéo envoyée",
  "[Document]": "document envoyé",
};

function readPlaceholder(text: string): string | null {
  return SYSTEM_PLACEHOLDERS[text.trim()] ?? null;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const outbound = readOutboundMessage(tool);
  // Livraison sortante : ligne affirmative et lisible, pas un bloc à déplier.
  if (outbound) {
    return (
      <p className="clawdeck-enter mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-emerald-300/15 bg-emerald-300/6 px-3 py-1.5 text-2xs text-emerald-200/90">
        <span aria-hidden>↗</span>
        <span>Message envoyé sur {channelLabel(outbound.channel)}</span>
        <span className="font-mono text-[var(--text-muted)]">{outbound.to}</span>
      </p>
    );
  }

  const complete = tool.phase === "result";
  const label = !complete ? "En cours" : tool.isError ? "Erreur" : "Terminé";
  const args = formatPayload(tool.args);
  const result = formatPayload(tool.result);
  // Un code de sortie non nul est un échec même si l'outil n'a pas levé
  // d'erreur : le dire explicitement plutôt que de le noyer dans la sortie.
  const failedExit = tool.exitCode !== undefined && tool.exitCode !== 0;

  return (
    <details className="clawdeck-enter group mt-3 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-black/25 text-xs">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-[var(--text-secondary)] marker:content-none">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            !complete
              ? "animate-pulse bg-[var(--status-warning)]"
              : tool.isError || failedExit
                ? "bg-[var(--status-critical)]"
                : "bg-[var(--status-good)]"
          }`}
          aria-hidden
        />
        {/* Titre calculé par OpenClaw (souvent la commande réelle) quand il
            existe : bien plus parlant que le nom d'outil brut. */}
        <span className="truncate font-mono text-2xs font-medium text-[var(--text-primary)]">
          {tool.title ?? tool.name}
        </span>
        {tool.durationMs !== undefined && (
          <span className="shrink-0 font-mono text-2xs text-[var(--text-muted)]">
            {formatDuration(tool.durationMs)}
          </span>
        )}
        {failedExit && (
          <span className="shrink-0 font-mono text-2xs text-red-300">sortie {tool.exitCode}</span>
        )}
        <span className="ml-auto shrink-0 text-2xs uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</span>
        <span className="shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-180" aria-hidden>
          ⌄
        </span>
      </summary>
      {(args || result || tool.output) && (
        <div className="space-y-3 border-t border-[var(--border-subtle)] px-3 py-3">
          {/* Sortie live : placée AVANT les arguments, c'est elle qu'on
              surveille pendant qu'une commande tourne. */}
          {tool.output && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                Sortie
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-5 text-[var(--text-secondary)]">
                {tool.output}
              </pre>
            </div>
          )}
          {args && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Arguments</p>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-5 text-[var(--text-secondary)]">
                {args}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Résultat</p>
              <pre
                className={`max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-5 ${
                  tool.isError ? "text-red-300" : "text-[var(--text-secondary)]"
                }`}
              >
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

const PROSE_CLASSES =
  "prose prose-invert max-w-none break-words text-chat " +
  "prose-headings:mb-2 prose-headings:mt-5 prose-headings:font-semibold prose-headings:tracking-tight " +
  "prose-p:my-2 prose-li:my-0.5 prose-a:text-emerald-300 prose-a:underline-offset-2 " +
  "prose-strong:text-[var(--text-primary)] " +
  // Cadre, fond et marges des blocs de code sont portés par PreBlock : les
  // laisser aussi ici empilerait deux bordures.
  "prose-pre:overflow-x-auto " +
  "prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none " +
  "prose-table:text-sm prose-th:font-semibold";

// Média reçu (photo, vocal WhatsApp). L'URL passe par /api/media, protégée
// par le bearer token : ni <img src> ni <audio src> ne peuvent poser d'en-tête,
// on récupère donc l'octet via fetch puis on expose un blob local. Le blob est
// révoqué au démontage, sinon chaque média fuiterait pour la durée de la page.
function MediaAttachment({ media }: { media: MessageMedia }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    const token = getToken();
    if (!token) return;

    const query = new URLSearchParams({ path: media.path, type: media.mime });
    fetch(`/api/media?${query}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [media.path, media.mime]);

  const kind = media.mime.split("/")[0];
  const name = media.path.split("/").pop() ?? "média";

  if (failed) {
    return (
      <p className="mt-2 text-2xs text-[var(--text-muted)]">
        Média indisponible — il a pu être nettoyé du workspace de l'agent.
      </p>
    );
  }
  if (!url) {
    return <p className="mt-2 text-2xs text-[var(--text-muted)]">Chargement du média…</p>;
  }
  if (kind === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mt-2 block">
        <img
          src={url}
          alt={`Image reçue : ${name}`}
          className="max-h-72 w-auto rounded-lg border border-[var(--border-subtle)]"
        />
      </a>
    );
  }
  if (kind === "audio") {
    // Contrôles natifs : un lecteur maison n'apporterait rien et perdrait
    // l'accessibilité clavier que le navigateur fournit déjà.
    return <audio src={url} controls preload="metadata" className="mt-2 w-full max-w-sm" />;
  }
  if (kind === "video") {
    return <video src={url} controls preload="metadata" className="mt-2 max-h-72 w-full rounded-lg" />;
  }
  return (
    <a
      href={url}
      download={name}
      className="mt-2 inline-block text-2xs text-emerald-300 underline underline-offset-2"
    >
      Télécharger {name}
    </a>
  );
}

function MessageBody({ message }: { message: ChatMessage }) {
  // Réponse en cours d'écriture ET déjà du texte : le curseur clignotant
  // prend le relais des trois points, qui ne couvrent que le texte vide.
  const streaming = message.pending && Boolean(message.text);

  // Contenu non retranscriptible : rendu en note, pas en message. La forme
  // dit à elle seule que ce ne sont pas les mots de l'expéditeur.
  const placeholder = readPlaceholder(message.text);
  if (placeholder) {
    return (
      <p className="flex items-center gap-1.5 py-0.5 text-xs italic text-[var(--text-muted)]">
        <span aria-hidden>◇</span>
        {placeholder}
      </p>
    );
  }

  if (!message.text) {
    return message.pending ? (
      <span className="inline-flex items-center gap-1 py-1 text-[var(--text-muted)]" aria-label="Réponse en cours">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
      </span>
    ) : null;
  }

  return (
    <div className={`${PROSE_CLASSES} ${streaming ? "clawdeck-streaming" : ""}`}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {message.text}
      </Markdown>
    </div>
  );
}

// Ligne d'état d'un message. Ne s'affiche QUE s'il y a quelque chose à dire :
// une ligne rendue en permanence réservait 28 px sous chaque bulle et gonflait
// un groupe à 119 px pour le mot « hey » (mesuré au DOM le 2026-07-25).
function MessageStatus({ message, onRetry, retryDisabled }: {
  message: ChatMessage;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const sending = message.sendState === "sending";
  const failed = message.sendState === "failed";
  if (!sending && !failed) return null;

  return (
    <div className="mt-1 flex items-center gap-2">
      <span className="text-2xs text-[var(--text-muted)]">
        {sending && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-current" aria-hidden />
            envoi en cours
          </span>
        )}
        {/* La cause est portée ICI et non dans la bulle : l'afficher aux deux
            endroits répétait la même phrase à deux lignes d'écart. */}
        {failed && (
          <span className="text-red-300">
            Échec de l'envoi{message.error ? ` — ${message.error}` : ""}
          </span>
        )}
      </span>
      {failed && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
          className="min-h-7 rounded-md border border-red-300/25 bg-red-300/10 px-2 text-2xs font-medium text-red-200 transition hover:bg-red-300/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
        >
          Réessayer
        </button>
      )}
    </div>
  );
}

// En-tête de groupe : auteur, heure, provenance — et la copie. Le bouton vit
// ICI plutôt que sous chaque bulle pour ne pas réserver une ligne d'actions
// par message ; il copie tout le groupe, ce qui est aussi plus utile quand
// l'agent a répondu en plusieurs morceaux.
function GroupHeading({ group }: { group: MessageGroup }) {
  const isUser = group.role === "user";
  const copyText = () =>
    group.messages
      .map((m) => m.text)
      .filter(Boolean)
      .join("\n\n");

  return (
    <div
      className={`mb-1 flex min-h-6 items-center gap-2 text-2xs ${isUser ? "justify-end" : "justify-start"}`}
    >
      <span className="font-medium tracking-[0.04em] text-[var(--text-secondary)]">
        {isUser ? "Vous" : "OpenClaw"}
      </span>
      <span className="font-mono text-[var(--text-muted)]">{formatTime(group.timestamp)}</span>
      {/* Provenance portée UNE fois par le groupe : sans elle, rien ne
          distingue ce qui a été écrit ici de ce qui vient du téléphone. */}
      {group.origin && (
        <span className="truncate rounded-full border border-[var(--border-subtle)] px-1.5 text-[var(--text-muted)]">
          via {channelLabel(group.origin.channel)}
        </span>
      )}
      {/* Modèle ayant réellement répondu. Le repli local peut prendre la main
          sans prévenir : savoir a posteriori quelle réponse en vient est une
          information d'exploitation. Il est donc signalé, le modèle nominal
          reste discret. */}
      {group.model && (
        <span
          className={`hidden truncate font-mono sm:inline ${
            isFallbackProvider(group.model.provider)
              ? "rounded-full border border-amber-300/25 px-1.5 text-amber-200/90"
              : "text-[var(--text-muted)]"
          }`}
          title={`${group.model.provider} / ${group.model.name}`}
        >
          {isFallbackProvider(group.model.provider) ? "repli local · " : ""}
          {group.model.name}
        </span>
      )}
      {/* Estompé au repos mais toujours tabulable : un contrôle ne doit pas
          dépendre du survol (UI_UX.md §7). */}
      <CopyButton
        getText={copyText}
        label={isUser ? "Copier votre message" : "Copier la réponse"}
        className="opacity-0 group-hover/grp:opacity-100"
      />
    </div>
  );
}

function GroupBlock({
  group,
  onRetry,
  retryDisabled,
  animate,
  highlightedId,
}: {
  group: MessageGroup;
  onRetry: (clientMessageId: string) => void;
  retryDisabled: boolean;
  animate: boolean;
  /** Message portant l'occurrence de recherche courante. */
  highlightedId: string | null;
}) {
  const isUser = group.role === "user";
  // Le rail de l'agent porte l'état de sa réponse : c'est lui qui signale un
  // streaming en cours ou une erreur, plutôt qu'un badge supplémentaire.
  const last = group.messages[group.messages.length - 1];
  const railTone = last?.error
    ? "bg-[var(--status-critical)]/50"
    : last?.pending
      ? "bg-[var(--accent)]/70"
      : "bg-[var(--border-strong)]";

  return (
    <section
      className={`group/grp ${animate ? "clawdeck-enter" : ""}`}
      aria-label={`${isUser ? "Vous" : "OpenClaw"} à ${formatTime(group.timestamp)}`}
    >
      <GroupHeading group={group} />
      <div className={isUser ? "flex flex-col items-end gap-1.5" : "flex gap-3"}>
        {!isUser && <span className={`w-px shrink-0 rounded-full ${railTone}`} aria-hidden />}
        <div className={isUser ? "flex w-full flex-col items-end gap-1.5" : "min-w-0 flex-1"}>
          {group.messages.map((message) => (
            <article
              key={message.id}
              // Cible du défilement de la recherche : les bornes d'occurrence
              // portent sur le markdown SOURCE, pas sur le DOM rendu — on
              // désigne donc le message entier plutôt que de surligner à côté.
              data-message-id={message.id}
              className={isUser ? "max-w-[85%] sm:max-w-[75%]" : "w-full"}
            >
              <div
                className={`${
                  isUser
                    ? "rounded-2xl rounded-br-md border border-emerald-300/12 bg-emerald-300/8 px-3.5 py-2"
                    : "rounded-lg"
                } ${
                  highlightedId === message.id
                    ? "outline outline-2 outline-offset-4 outline-emerald-300/60"
                    : ""
                }`}
              >
                {message.reasoning && (
                  <ReasoningBlock text={message.reasoning} live={message.pending} />
                )}
                <MessageBody message={message} />
                {message.media?.map((media) => (
                  <MediaAttachment key={media.path} media={media} />
                ))}
                {message.toolCalls.map((tool) => (
                  <ToolCallCard key={tool.id} tool={tool} />
                ))}
                {/* Erreur d'une RÉPONSE (interrompue, en échec côté agent).
                    L'échec d'un envoi, lui, est annoncé sous la bulle par
                    MessageStatus, avec son bouton de reprise. */}
                {message.error && message.sendState !== "failed" && (
                  <p className="mt-2 text-xs text-red-300">{message.error}</p>
                )}
              </div>
              <MessageStatus
                message={message}
                onRetry={
                  message.sendState === "failed" && message.clientMessageId
                    ? () => onRetry(message.clientMessageId!)
                    : undefined
                }
                retryDisabled={retryDisabled}
              />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DaySeparator({ timestamp, now }: { timestamp: number; now: number }) {
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      <span className="text-2xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {formatDayLabel(timestamp, now)}
      </span>
      <span className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}

// Où part un message écrit ici. Intégré DANS le cadre du composeur plutôt
// qu'en légende flottante : la particularité de ce produit est que ce qu'on
// tape part aussi sur un vrai téléphone. Le composeur porte donc son
// destinataire, comme un formulaire adressé.
function RouteHeader({ route }: { route: DeliveryRoute | null }) {
  if (!route) {
    return (
      <p className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-3 py-1.5 text-2xs text-[var(--text-muted)]">
        <span aria-hidden>○</span>
        Session interne — la réponse ne sortira pas d'ici
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-3 py-1.5 text-2xs text-emerald-200/85">
      <span aria-hidden>↗</span>
      <span className="font-medium">{channelLabel(route.channel)}</span>
      <span className="font-mono text-[var(--text-muted)]">{route.to}</span>
    </p>
  );
}

export function ChatPanel({ chat, active }: { chat: ChatController; active: boolean }) {
  const {
    messages,
    wsState,
    gatewayConnected,
    deliveryRoute,
    activity,
    activeRunId,
    abortPending,
    abortError,
    send,
    retry,
    abort,
  } = chat;

  const [draft, setDraft] = useState(readStoredDraft);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // « Suit le bas du fil » : état et non ref, l'UI en dépend désormais.
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const seenIdsRef = useRef(new Set<string>());
  // Un scrollTo programmé déclenche lui aussi onScroll, avec des positions
  // intermédiaires loin du bas : sans cette fenêtre de garde, l'animation
  // douce se ferait passer pour une remontée manuelle et ferait clignoter le
  // bouton « nouveaux messages ».
  const programmaticScrollUntilRef = useRef(0);
  // Horloge grossière : sert aux libellés « Aujourd'hui » / « Hier », qui
  // n'ont pas besoin de la seconde près.
  const [today, setToday] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setToday(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [highlight, setHighlight] = useState<ChatSearchHighlight | null>(null);
  const highlightedId = highlight?.active?.messageId ?? null;

  // Ctrl/Cmd+F détourné TANT QUE l'onglet chat est actif : chercher dans une
  // conversation est l'attente évidente de ce raccourci ici, et la recherche
  // native ne verrait de toute façon que la portion rendue du fil.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Amener l'occurrence courante sous les yeux. `block: "center"` plutôt que
  // le défaut : une occurrence collée en haut ou en bas du cadre est
  // difficile à situer dans la conversation.
  useEffect(() => {
    if (!highlightedId) return;
    const node = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(highlightedId)}"]`);
    if (!node) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    programmaticScrollUntilRef.current = Date.now() + (reduceMotion ? 100 : 700);
    node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  }, [highlightedId]);

  const timeline = useMemo(() => buildTimeline(messages), [messages]);

  useEffect(() => storeDraft(draft), [draft]);

  const scrollToBottom = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    // Un behavior explicite ignore la règle CSS prefers-reduced-motion : on
    // respecte la préférence ici même.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    programmaticScrollUntilRef.current = Date.now() + (reduceMotion ? 100 : 700);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }, []);

  useEffect(() => {
    // Panneau masqué (autre onglet) : hauteurs à zéro, on rattrape le bas de
    // conversation au retour sur l'onglet plutôt qu'à chaque message.
    if (!active || !following) return;
    scrollToBottom();
  }, [messages, active, following, scrollToBottom]);

  useEffect(() => {
    // Onglet masqué : rien n'est « vu », le compteur doit continuer à monter.
    if (!active) return;
    if (following) {
      seenIdsRef.current = new Set(messages.map((m) => m.id));
      setUnread(0);
      return;
    }
    // Mes propres envois ne comptent pas comme « nouveaux » : je viens de les
    // écrire. Ceux venus d'un canal externe (origin renseigné), si.
    setUnread(
      messages.filter((m) => !seenIdsRef.current.has(m.id) && !(m.role === "user" && !m.origin)).length,
    );
  }, [messages, active, following]);

  // Composeur auto-extensible : hauteur recalculée AVANT peinture pour ne pas
  // laisser voir un saut d'une ligne à l'autre.
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [draft]);

  const connected = wsState === "open" && gatewayConnected;
  const statusLabel =
    wsState === "connecting"
      ? "Connexion au relais"
      : wsState === "unauthorized"
        ? "Authentification requise"
        : wsState !== "open"
          ? "Relais déconnecté"
          : gatewayConnected
            ? "Gateway connectée"
            : "Gateway indisponible";

  const tooLong = draft.length > MAX_CHAT_TEXT_LENGTH;
  const showCounter = draft.length >= MAX_CHAT_TEXT_LENGTH * COUNTER_REVEAL_RATIO;
  const canSend = connected && draft.trim().length > 0 && !tooLong;

  function submit() {
    if (!canSend) return;
    if (send(draft)) {
      setDraft("");
      // Envoyer vaut retour au bas du fil : on veut voir sa propre réponse.
      setFollowing(true);
    }
  }

  // Nom volontairement non préfixé « use » : ce n'est pas un hook.
  function applyStarter(text: string) {
    setDraft(text);
    textareaRef.current?.focus();
  }

  return (
    <section
      // Hauteur mobile en `dvh` : sur iOS, `vh` compte la barre d'adresse
      // rétractée, donc le composeur finissait masqué par le chrome du
      // navigateur. Le plancher reste bas pour que la zone de saisie tienne
      // toujours à l'écran sur un téléphone.
      className="flex h-[calc(100dvh-13rem)] min-h-[22rem] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] sm:h-[calc(100vh-16rem)] sm:min-h-[34rem] sm:max-h-[54rem]"
      onKeyDown={(event) => {
        // Échap interrompt la réponse en cours, où que soit le focus dans le
        // panneau — raccourci attendu de tout client de chat moderne.
        if (event.key === "Escape" && activeRunId && !abortPending) {
          event.preventDefault();
          abort();
        }
      }}
    >
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 sm:px-5">
        <h2 className="text-sm font-semibold tracking-tight">Conversation</h2>
        <div className="ml-auto flex items-center gap-2">
          {/* Affordance visible : un raccourci clavier seul serait
              indécouvrable, et l'onglet se consulte aussi au tactile. */}
          <button
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
            aria-expanded={searchOpen}
            className={`min-h-10 rounded-lg border px-2.5 text-2xs transition active:scale-[0.97] sm:min-h-8 ${
              searchOpen
                ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-200"
                : "border-[var(--border-subtle)] bg-black/20 text-[var(--text-secondary)] hover:bg-white/6"
            }`}
          >
            Rechercher
          </button>
        <div
          className="flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-black/20 px-2.5 py-1 text-2xs text-[var(--text-secondary)]"
          aria-live="polite"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[var(--status-good)]" : "bg-[var(--status-warning)]"}`}
            aria-hidden
          />
          <span className="hidden sm:inline">{statusLabel}</span>
          <span className="sm:hidden">{connected ? "Connecté" : "Hors ligne"}</span>
        </div>
        </div>
      </header>

      {searchOpen && (
        <ChatSearch
          messages={messages}
          onClose={() => setSearchOpen(false)}
          onHighlight={setHighlight}
        />
      )}

      {/* Résumé opérationnel du panneau, avant le détail (UI_UX.md §2) : ce
          que fait l'agent maintenant, y compris pour un run venu d'ailleurs. */}
      <ActivityStrip activity={activity} connected={connected} />

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full space-y-4 overflow-y-auto px-4 py-5 sm:px-6"
          role="log"
          aria-live="polite"
          aria-label="Messages de la conversation"
          onScroll={(event) => {
            // Défilement programmé en cours : ce n'est pas l'utilisateur qui
            // remonte, on ne réévalue pas le suivi.
            if (Date.now() < programmaticScrollUntilRef.current) return;
            const element = event.currentTarget;
            setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
          }}
        >
          {messages.length === 0 && (
            <div className="flex h-full min-h-60 flex-col items-center justify-center px-2 text-center">
              <p className="text-sm font-medium text-[var(--text-secondary)]">La conversation est prête</p>
              <p className="mt-2 max-w-sm text-xs leading-5 text-[var(--text-muted)]">
                Les messages, appels d'outils et réponses de la session principale apparaissent ici — y
                compris ceux échangés depuis WhatsApp.
              </p>
              <ul className="mt-5 flex flex-wrap justify-center gap-2">
                {STARTERS.map((starter) => (
                  <li key={starter}>
                    <button
                      type="button"
                      onClick={() => applyStarter(starter)}
                      disabled={!connected}
                      className="min-h-8 rounded-full border border-[var(--border-subtle)] bg-black/20 px-3 text-xs text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:bg-white/6 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {starter}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {timeline.map((item) =>
            item.kind === "day" ? (
              <DaySeparator key={item.key} timestamp={item.timestamp} now={today} />
            ) : (
              <GroupBlock
                key={item.key}
                group={item}
                onRetry={retry}
                retryDisabled={!connected}
                // L'historique initial (ids `history-*`) n'est pas animé :
                // l'animation signale un groupe NOUVEAU, pas le remplissage
                // de la vue au chargement.
                animate={!item.messages[0]?.id.startsWith("history-")}
                highlightedId={highlightedId}
              />
            ),
          )}
        </div>

        {unread > 0 && (
          // Centrage par flex et non par -translate-x-1/2 : l'animation
          // d'entrée anime `transform`, elle écraserait le centrage et le
          // bouton sauterait latéralement à l'apparition.
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={() => {
                setFollowing(true);
                scrollToBottom();
              }}
              className="clawdeck-enter pointer-events-auto flex min-h-9 items-center gap-2 rounded-full border border-emerald-300/25 bg-[var(--surface-overlay)] px-4 text-xs font-medium text-emerald-200 shadow-[var(--shadow-float)] transition hover:bg-white/8 active:scale-[0.97]"
            >
              <span aria-hidden>↓</span>
              {unread} nouveau{unread > 1 ? "x" : ""} message{unread > 1 ? "s" : ""}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-[var(--border-subtle)] bg-black/15 p-3 sm:p-4">
        {activeRunId && (
          <div className="clawdeck-enter mb-2 flex min-h-9 items-center justify-between gap-3 rounded-lg border border-amber-300/15 bg-amber-300/6 px-3 py-1.5">
            <span className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-warning)]" aria-hidden />
              Réponse en cours
            </span>
            <button
              type="button"
              onClick={abort}
              disabled={abortPending || wsState !== "open"}
              className="min-h-10 rounded-md border border-[var(--border-strong)] bg-black/25 px-3 sm:min-h-7 text-xs text-[var(--text-primary)] transition hover:bg-white/8 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {abortPending ? "Interruption demandée…" : "Interrompre"}
            </button>
          </div>
        )}
        {/* Région persistante : un échec d'interruption est annoncé même si la
            barre « Réponse en cours » a déjà disparu. */}
        <p className={abortError ? "mb-2 px-1 text-xs text-red-300" : "sr-only"} aria-live="polite">
          {abortError ? `Interruption impossible : ${abortError}` : ""}
        </p>

        <form
          className="overflow-hidden rounded-xl border border-[var(--border-strong)] bg-black/25 transition-colors focus-within:border-emerald-300/30"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {connected && <RouteHeader route={deliveryRoute} />}
          <label htmlFor="chat-draft" className="sr-only">
            Message à OpenClaw
          </label>
          <textarea
            id="chat-draft"
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={
              connected
                ? "Écrire un message…"
                : wsState !== "open"
                  ? "Envoi indisponible : connexion à clawdeck interrompue"
                  : "Envoi indisponible tant que la gateway est hors ligne"
            }
            disabled={!connected}
            className="block max-h-[200px] min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-chat text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-2 pt-0.5">
            <p className="hidden text-2xs text-[var(--text-muted)] sm:block">
              Entrée pour envoyer · Maj + Entrée pour une ligne
              {activeRunId && " · Échap pour interrompre"}
            </p>
            <div className="ml-auto flex items-center gap-3">
              {/* Compteur révélé à l'approche de la limite seulement : afficher
                  en permanence « 12 / 8 000 » serait du bruit. */}
              {showCounter && (
                <span
                  className={`font-mono text-2xs ${tooLong ? "text-red-300" : "text-[var(--text-muted)]"}`}
                  aria-live="polite"
                >
                  {draft.length.toLocaleString("fr-FR")} / {MAX_CHAT_TEXT_LENGTH.toLocaleString("fr-FR")}
                </span>
              )}
              <button
                type="submit"
                disabled={!canSend}
                className="min-h-10 rounded-lg bg-emerald-300 px-4 text-xs font-semibold text-[var(--text-on-accent)] transition hover:bg-emerald-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35 sm:min-h-8"
              >
                Envoyer
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
