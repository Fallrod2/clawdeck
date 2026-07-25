// src/components/ChatSearch.tsx — barre de recherche du transcript.
//
// Ce qu'elle cherche, et ce qu'elle en dit : useChat garde au plus 500 messages
// EN MÉMOIRE et clawdeck ne duplique jamais l'historique d'OpenClaw
// (CLAUDE.md), donc il n'existe aucune recherche côté serveur à appeler. La
// barre ne peut porter que sur ce qui est chargé — elle l'annonce en toutes
// lettres sous le champ plutôt que de laisser croire à une recherche
// exhaustive, ce qui ferait conclure à tort « ce message n'existe pas ».
//
// CONTRAT D'INTÉGRATION (le câblage vit dans ChatPanel) :
//
//   const [searchOpen, setSearchOpen] = useState(false);
//   const [highlight, setHighlight] = useState<ChatSearchHighlight | null>(null);
//   …
//   {searchOpen && (
//     <ChatSearch
//       messages={messages}
//       onClose={() => setSearchOpen(false)}
//       onHighlight={setHighlight}
//     />
//   )}
//
// - Monter le composant OUVRE la recherche (le focus part dans le champ) ;
//   le démonter la ferme. `onClose` ne fait que demander ce démontage.
// - `onHighlight` reçoit l'état complet à chaque changement de requête, de
//   résultats ou d'occurrence courante, et `null` au démontage : le parent
//   efface alors ses marques. Elle n'a pas besoin d'être stable — elle est
//   gardée dans une ref, une lambda en ligne ne provoque pas de boucle.
// - Le surlignage appartient au parent : `groupMatchesByMessage` puis
//   `splitByMatches` sur le texte du message ; `highlight.active` désigne
//   l'occurrence à distinguer et le message vers lequel faire défiler.
// - Échap est arrêté ici (stopPropagation) : le panneau s'en sert pour
//   interrompre le run en cours, fermer la recherche ne doit pas couper l'agent.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../lib/chatTypes";
import { MAX_MATCHES, searchMessages, type SearchMatch, type SearchResults } from "../lib/chatSearch";

export interface ChatSearchHighlight {
  /** Requête telle que saisie. */
  query: string;
  /** Résultat complet : occurrences, messages concernés, collecte tronquée. */
  results: SearchResults;
  /** Occurrence courante — celle à distinguer et vers laquelle défiler. */
  active: SearchMatch | null;
}

export interface ChatSearchProps {
  /** Transcript affiché, dans l'ordre du fil (celui de `useChat`). */
  messages: ChatMessage[];
  /** Demande de fermeture : Échap ou bouton « Fermer la recherche ». */
  onClose: () => void;
  /** État de surlignage, `null` quand la recherche disparaît. */
  onHighlight?: (highlight: ChatSearchHighlight | null) => void;
}

const CONTROL_CLASSES =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] " +
  "bg-black/20 text-[var(--text-secondary)] transition hover:bg-white/8 hover:text-[var(--text-primary)] " +
  "active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/20";

export function ChatSearch({ messages, onClose, onHighlight }: ChatSearchProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchMessages(messages, query), [messages, query]);
  const total = results.matches.length;
  // Le fil continue de vivre pendant la recherche (streaming, message reçu de
  // WhatsApp) : l'occurrence visée peut disparaître entre deux rendus. On borne
  // ici plutôt que de laisser un compteur afficher « 7 / 3 ».
  const index = total === 0 ? -1 : Math.min(cursor, total - 1);
  const active = index < 0 ? null : (results.matches[index] ?? null);

  // La barre n'apparaît que sur demande explicite : le focus y va tout de
  // suite, sinon il faudrait viser le champ à la souris après l'avoir ouvert
  // au clavier.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Callback gardée en ref : le parent passera vraisemblablement une lambda en
  // ligne, la mettre en dépendance ferait re-notifier à chaque rendu.
  const emit = useRef(onHighlight);
  useEffect(() => {
    emit.current = onHighlight;
  });
  useEffect(() => {
    emit.current?.({ query, results, active });
  }, [query, results, active]);
  // Fermeture : le parent doit pouvoir retirer ses marques, y compris si la
  // barre disparaît sans passer par le bouton (changement d'onglet).
  useEffect(() => () => emit.current?.(null), []);

  function step(delta: number) {
    if (total === 0) return;
    // Navigation circulaire : arriver au bout ne doit pas donner l'impression
    // d'un bouton cassé, comme dans la recherche d'un navigateur.
    setCursor((((index + delta) % total) + total) % total);
  }

  const searching = query.trim().length > 0;
  const loaded = messages.length;
  // « les 1 message » ne se dit pas : le périmètre change de tournure au
  // singulier plutôt que d'accoler un « s » optionnel.
  const scope = loaded > 1 ? `les ${loaded} messages chargés` : "le seul message chargé";
  const hitPlural = results.messageCount > 1 ? "s" : "";

  // Un seul texte porte les états de la vue (UI_UX.md §6) : rien de chargé,
  // requête vide, aucun résultat, et — dans tous les cas — le périmètre réel.
  const status =
    loaded === 0
      ? "Aucun message chargé : il n'y a rien à parcourir pour l'instant."
      : !searching
        ? `Recherche dans ${scope} en mémoire, pas dans tout l'historique d'OpenClaw.`
        : total === 0
          ? `Aucun résultat dans ${scope}. Essayez un mot plus court ; les échanges plus anciens ne sont pas interrogés.`
          : `${results.messageCount} message${hitPlural} concerné${hitPlural} sur ${scope}, pas plus loin dans l'historique.` +
            // Le « + » du compteur ne s'explique pas tout seul : on dit où la
            // collecte s'est arrêtée et quoi faire pour la resserrer.
            (results.truncated ? ` Recherche arrêtée à ${MAX_MATCHES} occurrences : précisez la requête.` : "");

  return (
    <div
      // L'apparition signale un changement d'état réel — la barre s'ouvre à la
      // demande (UI_UX.md §5). L'animation est neutralisée par la règle globale
      // prefers-reduced-motion.
      className="clawdeck-enter flex flex-col gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2 sm:px-5"
      role="search"
      aria-label="Recherche dans la conversation"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // preventDefault : sur WebKit, Échap dans un champ `type="search"`
        // vide sa valeur au lieu de laisser fermer la barre.
        event.preventDefault();
        // Le panneau parent interprète Échap comme « interrompre la réponse » :
        // fermer la recherche ne doit pas couper l'agent au passage.
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="chat-search" className="sr-only">
          Rechercher dans la conversation
        </label>
        <input
          id="chat-search"
          ref={inputRef}
          type="search"
          value={query}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Rechercher dans la conversation…"
          onChange={(event) => {
            setQuery(event.target.value);
            // Toute nouvelle requête repart de la première occurrence : garder
            // le rang précédent enverrait au milieu d'un résultat sans rapport.
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }}
          className="min-h-10 w-full min-w-0 flex-1 basis-full rounded-lg border border-[var(--border-subtle)] bg-black/25 px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)] sm:basis-auto"
        />

        <div className="ml-auto flex items-center gap-1">
          {searching && (
            // Compteur en monospace : il change à chaque déplacement, des
            // chiffres de largeur variable le feraient gigoter.
            <span
              className={`px-1 font-mono text-2xs ${total === 0 ? "text-[var(--status-warning)]" : "text-[var(--text-secondary)]"}`}
              aria-hidden
            >
              {total === 0 ? "0" : `${index + 1} / ${total}${results.truncated ? "+" : ""}`}
            </span>
          )}
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={total === 0}
            title="Occurrence précédente (Maj + Entrée)"
            aria-label="Occurrence précédente"
            className={CONTROL_CLASSES}
          >
            <span aria-hidden>↑</span>
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={total === 0}
            title="Occurrence suivante (Entrée)"
            aria-label="Occurrence suivante"
            className={CONTROL_CLASSES}
          >
            <span aria-hidden>↓</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Fermer la recherche (Échap)"
            aria-label="Fermer la recherche"
            className={CONTROL_CLASSES}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      </div>

      <div className="flex items-baseline gap-3 text-2xs text-[var(--text-muted)]">
        <p className="min-w-0 flex-1">{status}</p>
        <p className="hidden shrink-0 sm:block">Entrée suivant · Maj + Entrée précédent · Échap fermer</p>
      </div>

      {/* Le compteur visuel est trop télégraphique pour être lu à voix haute :
          la position est annoncée en toutes lettres, une seule fois par
          déplacement. */}
      <p className="sr-only" aria-live="polite">
        {!searching
          ? ""
          : total === 0
            ? "Aucun résultat"
            : `Occurrence ${index + 1} sur ${total}${results.truncated ? " ou plus" : ""}`}
      </p>
    </div>
  );
}
