// src/components/NotificationStack.tsx — présentation des notifications.
//
// Ancrage bas de l'écran et non haut : sur téléphone, c'est la zone
// atteignable au pouce, et l'en-tête collant occupe déjà le haut. Sur grand
// écran, la pile reste à droite pour ne pas recouvrir la colonne de contenu.
//
// Aucune notification ne disparaît toute seule si elle porte une erreur : un
// avertissement qu'on rate en regardant ailleurs n'a pas rempli son office.
// Les informations, elles, s'effacent — les laisser s'empiler ferait de cette
// zone un historique, ce que l'architecture du projet refuse.

import { useEffect, useRef } from "react";
import type { DashboardNotification, NotificationSeverity } from "../hooks/useNotifications";

// Durées de vie par gravité. `null` = persiste jusqu'à fermeture explicite.
const AUTO_DISMISS_MS: Record<NotificationSeverity, number | null> = {
  info: 8_000,
  warning: 20_000,
  error: null,
};

const TONE: Record<NotificationSeverity, { border: string; text: string; symbol: string; label: string }> = {
  info: {
    border: "border-[var(--border-strong)]",
    text: "text-[var(--text-secondary)]",
    symbol: "·",
    label: "Information",
  },
  warning: {
    border: "border-amber-300/25",
    text: "text-amber-200",
    symbol: "!",
    label: "Avertissement",
  },
  error: {
    border: "border-red-300/30",
    text: "text-red-200",
    symbol: "!",
    label: "Erreur",
  },
};

function NotificationCard({
  notification,
  onDismiss,
}: {
  notification: DashboardNotification;
  onDismiss: () => void;
}) {
  const tone = TONE[notification.severity];

  // La fermeture est gardée en ref, et le minuteur ne dépend QUE de l'identité
  // de la notification. Le parent passe une lambda en ligne et App se re-rend
  // chaque seconde (horloge de fraîcheur) : mettre `onDismiss` en dépendance
  // réarmait le minuteur à chaque battement, et une notification
  // d'information ne disparaissait jamais.
  const fermer = useRef(onDismiss);
  useEffect(() => {
    fermer.current = onDismiss;
  });
  useEffect(() => {
    const delay = AUTO_DISMISS_MS[notification.severity];
    if (delay === null) return;
    const timer = setTimeout(() => fermer.current(), delay);
    return () => clearTimeout(timer);
  }, [notification.id, notification.severity]);

  return (
    <article
      // `alert` interrompt la lecture d'écran, `status` attend une pause :
      // réservé à ce qui est vraiment une erreur, sinon l'interruption devient
      // du bruit et on cesse d'y prêter attention.
      role={notification.severity === "error" ? "alert" : "status"}
      className={`clawdeck-enter pointer-events-auto w-full max-w-sm rounded-xl border ${tone.border} bg-[var(--surface-overlay)] p-3 shadow-[var(--shadow-float)]`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 font-mono text-2xs ${tone.text}`} aria-hidden>
          {tone.symbol}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-xs font-semibold ${tone.text}`}>
            <span className="sr-only">{tone.label} : </span>
            {notification.title}
          </p>
          <p className="mt-1 break-words text-xs leading-5 text-[var(--text-secondary)]">
            {notification.message}
          </p>
          {notification.tags.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1">
              {notification.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-[var(--border-subtle)] px-1.5 font-mono text-2xs text-[var(--text-muted)]"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Fermer : ${notification.title}`}
          className="-mr-1 -mt-1 min-h-8 min-w-8 shrink-0 rounded-lg text-[var(--text-muted)] transition hover:bg-white/8 hover:text-[var(--text-primary)] active:scale-[0.97]"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
    </article>
  );
}

export function NotificationStack({
  notifications,
  dropped,
  onDismiss,
  onClearDropped,
}: {
  notifications: DashboardNotification[];
  dropped: number;
  onDismiss: (id: string) => void;
  onClearDropped: () => void;
}) {
  if (notifications.length === 0 && dropped === 0) return null;

  return (
    // `pointer-events-none` sur le conteneur, réactivé sur chaque carte : la
    // pile ne doit jamais intercepter un clic destiné au contenu derrière elle.
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 p-3 sm:inset-x-auto sm:right-4 sm:items-end"
      aria-label="Notifications"
    >
      {dropped > 0 && (
        <p
          role="status"
          className="clawdeck-enter pointer-events-auto w-full max-w-sm rounded-xl border border-amber-300/25 bg-[var(--surface-overlay)] p-3 text-xs text-amber-200 shadow-[var(--shadow-float)]"
        >
          {dropped} notification{dropped > 1 ? "s" : ""} perdue{dropped > 1 ? "s" : ""} — flux saturé,
          elles ne sont conservées nulle part.{" "}
          <button
            type="button"
            onClick={onClearDropped}
            className="underline underline-offset-2 hover:text-amber-100"
          >
            Masquer
          </button>
        </p>
      )}
      {notifications.map((notification) => (
        <NotificationCard
          key={notification.id}
          notification={notification}
          onDismiss={() => onDismiss(notification.id)}
        />
      ))}
    </div>
  );
}
