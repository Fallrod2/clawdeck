// src/components/ChatPanel.tsx — conversation principale, streaming et outils.
// Le hook useChat vit dans App (la connexion doit survivre au changement
// d'onglet) : ce panneau ne fait qu'afficher son état et relayer ses actions.

import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
// GFM : tableaux, listes de tâches et texte barré produits par l'agent —
// sans rehype-raw, le HTML reste échappé (pas de XSS).
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import type { ChatMessage, DeliveryRoute, ToolCall } from "../lib/chatTypes";
import type { ChatController } from "../hooks/useChat";
import { ActivityStrip } from "./ActivityStrip";

const REMARK_PLUGINS = [remarkGfm];

// Bloc de code enrichi d'un bouton de copie. Le texte est lu au clic depuis
// le DOM (textContent) plutôt que reconstruit depuis les nœuds markdown :
// c'est exactement ce que l'utilisateur voit, sauts de ligne compris.
function PreBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code relative">
      <pre ref={ref} {...props}>
        {children}
      </pre>
      <CopyButton
        getText={() => ref.current?.textContent ?? ""}
        label="Copier le bloc de code"
        className="absolute right-2 top-2 opacity-0 group-hover/code:opacity-100"
      />
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

// Où part un message écrit ici. Sans route externe connue, la réponse reste
// dans la session : le dire explicitement évite de croire le téléphone servi.
function DeliveryBadge({ route }: { route: DeliveryRoute | null }) {
  const external = route !== null;
  return (
    <p
      className={`clawdeck-enter mb-2 flex items-center gap-1.5 px-1 text-[11px] ${
        external ? "text-emerald-200/85" : "text-[var(--text-muted)]"
      }`}
      aria-live="polite"
    >
      <span aria-hidden>{external ? "↗" : "○"}</span>
      {external ? (
        <span>
          Relayé vers {channelLabel(route.channel)}
          <span className="text-[var(--text-muted)]"> · {route.to}</span>
        </span>
      ) : (
        <span>Session interne seule — aucun canal externe épinglé</span>
      )}
    </p>
  );
}

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
    <details className="clawdeck-enter group mt-3 overflow-hidden rounded-lg border border-white/8 bg-black/20 text-xs">
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

function MessageBubble({
  message,
  onRetry,
  retryDisabled,
}: {
  message: ChatMessage;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const isUser = message.role === "user";
  const time = new Date(message.timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  // L'historique initial (ids `history-*`) n'est pas animé : l'animation
  // d'arrivée signale un message NOUVEAU, pas le remplissage de la vue au
  // chargement — sinon cinquante bulles s'animeraient d'un coup.
  const isNew = !message.id.startsWith("history-");
  // Réponse en cours d'écriture ET déjà du texte : le curseur clignotant
  // prend le relais des trois points, qui ne couvrent que le texte vide.
  const streaming = message.pending && Boolean(message.text);

  return (
    <article
      className={`group/message flex ${isNew ? "clawdeck-enter" : ""} ${isUser ? "justify-end" : "justify-start"}`}
      aria-label={`Message ${isUser ? "utilisateur" : "assistant"} à ${time}${
        message.origin ? `, reçu via ${channelLabel(message.origin.channel)}` : ""
      }`}
    >
      <div className={`max-w-[92%] sm:max-w-[82%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser
              ? "rounded-br-md border border-emerald-300/12 bg-emerald-300/9"
              : "rounded-bl-md border border-white/8 bg-[var(--surface-raised)]"
          }`}
        >
          {message.text ? (
            <div
              className={`prose prose-invert prose-sm max-w-none break-words prose-headings:mb-2 prose-headings:mt-4 prose-p:my-1.5 prose-p:leading-6 prose-a:text-emerald-300 prose-pre:my-3 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:border prose-pre:border-white/8 prose-pre:bg-black/25 prose-code:text-[0.82em] ${
                streaming ? "clawdeck-streaming" : ""
              }`}
            >
              <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
                {message.text}
              </Markdown>
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
          {message.sendState === "failed" && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
              className="mt-2 min-h-8 rounded-lg border border-red-300/25 bg-red-300/10 px-3 text-xs font-medium text-red-200 transition hover:bg-red-300/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Réessayer
            </button>
          )}
        </div>
        {/* Les changements d'état d'envoi (envoi en cours → accusé/échec) sont
            annoncés par la région role="log" aria-live du conteneur : pas de
            live region imbriquée pour éviter les annonces doublées. L'accusé
            reste discret : le suffixe « envoi en cours » disparaît. */}
        <div className={`mt-1.5 flex items-center gap-2 px-1 ${isUser ? "justify-end" : "justify-start"}`}>
          <p className="font-mono text-[10px] text-[var(--text-muted)]">
            {isUser ? "Vous" : "OpenClaw"} · {time}
            {/* Message entré par un canal externe : sans cette mention, rien ne
                distingue ce que j'ai écrit ici de ce que j'ai écrit au téléphone. */}
            {message.origin && ` · via ${channelLabel(message.origin.channel)}`}
            {message.pending ? " · en cours" : ""}
            {message.sendState === "sending" && (
              <span>
                {" · "}
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-current align-middle" aria-hidden />
                {" envoi en cours"}
              </span>
            )}
            {message.sendState === "failed" && <span className="text-red-300"> · échec de l'envoi</span>}
          </p>
          {/* Estompé au repos mais toujours tabulable : un contrôle ne doit
              pas dépendre du survol (UI_UX.md §7). */}
          {message.text && (
            <CopyButton
              getText={() => message.text}
              label="Copier le message"
              className="opacity-0 group-hover/message:opacity-100"
            />
          )}
        </div>
      </div>
    </article>
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
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // « Suit le bas du fil » : état et non ref, l'UI en dépend désormais.
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  // Ids déjà vus, figés au dernier passage en bas de fil.
  const seenIdsRef = useRef(new Set<string>());
  // Un scrollTo programmé déclenche lui aussi onScroll, avec des positions
  // intermédiaires loin du bas : sans cette fenêtre de garde, l'animation
  // douce se ferait passer pour une remontée manuelle et ferait clignoter le
  // bouton « nouveaux messages ».
  const programmaticScrollUntilRef = useRef(0);

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

  function submit() {
    if (!connected || !draft.trim()) return;
    if (send(draft)) {
      setDraft("");
      // Envoyer vaut retour au bas du fil : on veut voir sa propre réponse.
      setFollowing(true);
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

      {/* Résumé opérationnel du panneau, avant le détail (UI_UX.md §2) : ce
          que fait l'agent maintenant, y compris pour un run venu d'ailleurs. */}
      <ActivityStrip activity={activity} connected={connected} />

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full space-y-5 overflow-y-auto px-4 py-5 sm:px-6"
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
          {messages.map((message) => {
            const retryId = message.sendState === "failed" ? message.clientMessageId : undefined;
            return (
              <MessageBubble
                key={message.id}
                message={message}
                onRetry={retryId ? () => retry(retryId) : undefined}
                retryDisabled={!connected}
              />
            );
          })}
        </div>
        {/* Remonté dans le fil pendant que ça continue en bas : sans ce
            repère, rien ne signale l'arrivée d'un message hors de vue —
            l'autoscroll est justement désactivé dans ce cas. */}
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
              className="clawdeck-enter pointer-events-auto flex min-h-9 items-center gap-2 rounded-full border border-emerald-300/25 bg-[var(--surface-raised)] px-4 text-xs font-medium text-emerald-200 shadow-lg shadow-black/40 transition hover:bg-white/8 active:scale-[0.97]"
            >
              <span aria-hidden>↓</span>
              {unread} nouveau{unread > 1 ? "x" : ""} message{unread > 1 ? "s" : ""}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-white/8 bg-black/10 p-3 sm:p-4">
        {activeRunId && (
          <div className="clawdeck-enter mb-2 flex min-h-10 items-center justify-between gap-3 rounded-lg border border-amber-300/15 bg-amber-300/6 px-3 py-1.5">
            <span className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden />
              Réponse en cours
            </span>
            <button
              type="button"
              onClick={abort}
              disabled={abortPending || wsState !== "open"}
              className="min-h-8 rounded-md border border-white/12 bg-black/20 px-3 text-xs text-[var(--text-primary)] transition hover:bg-white/8 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
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
        {/* Hors connexion, aucune route ne peut être affirmée : la pastille
            d'état de l'en-tête porte déjà l'information. */}
        {/* La clé remonte le badge quand la route change : son animation
            d'entrée rejoue, seul signal visible d'une bascule du canal. */}
        {connected && (
          <DeliveryBadge key={deliveryRoute ? `${deliveryRoute.channel}:${deliveryRoute.to}` : "interne"} route={deliveryRoute} />
        )}
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
            placeholder={
              connected
                ? "Écrire un message…"
                : wsState !== "open"
                  ? "Envoi indisponible : connexion à clawdeck interrompue"
                  : "Envoi indisponible tant que la gateway est hors ligne"
            }
            disabled={!connected}
            className="max-h-32 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-3 px-1 pt-1">
            <p className="hidden text-[10px] text-[var(--text-muted)] sm:block">Entrée pour envoyer · Maj + Entrée pour une ligne</p>
            <button
              type="submit"
              disabled={!connected || !draft.trim()}
              className="ml-auto min-h-9 rounded-lg bg-emerald-300 px-4 text-xs font-semibold text-[var(--text-on-accent)] transition hover:bg-emerald-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35"
            >
              Envoyer
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
