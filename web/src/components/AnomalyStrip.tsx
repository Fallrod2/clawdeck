// src/components/AnomalyStrip.tsx — ce qui a lâché récemment, même revenu au vert.
//
// Raison d'être : les deux bandeaux du dessus concluent sur l'INSTANT. Une
// coupure de trois minutes à 3 h du matin n'y laissait aucune trace — la sonde
// repassait au vert et l'incident cessait d'exister, alors que c'est
// précisément la question qu'on vient poser le matin. Ce panneau restitue le
// journal tenu par le backend (src/anomalies.ts) ; il ne détecte rien
// lui-même, un navigateur fermé ne voit rien passer.
//
// Panneau et non troisième bandeau coloré : le résumé global et le diagnostic
// réseau sont des conclusions sur l'état courant et doivent rester les deux
// seules bandes de couleur de la vue. Un historique est un objet d'une autre
// nature, il se lit après elles et sur une surface neutre.
//
// Replié par défaut : la ligne d'en-tête porte déjà le compte et la dernière
// anomalie. Déplié d'office, un mauvais épisode (jusqu'à 12 entrées) pousserait
// les cartes d'état sous la ligne de flottaison à 390 px — l'inverse de la
// hiérarchie voulue.

import { useState, type ReactNode } from "react";
import type { AnomalyEntry, AnomalyJournal } from "../lib/types";
import { formatElapsed } from "../lib/activity";
import { formatRelativeAgeFr, useNow } from "../hooks/useNow";

const SEVERITY = {
  critical: { dot: "var(--status-critical)", noun: "Indisponibilité" },
  warning: { dot: "var(--status-warning)", noun: "Dégradation" },
} as const;

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Fenêtre réellement couverte : le journal ne remonte jamais avant le
 *  démarrage du backend, et jamais au-delà de sa rétention. Dire l'une ou
 *  l'autre selon celle qui mord évite d'annoncer « 24 h » à un service relancé
 *  il y a dix minutes. */
function windowText(journal: AnomalyJournal, now: number): string {
  const uptimeMs = Math.max(0, now - journal.since);
  if (uptimeMs < journal.retentionMs) {
    return `depuis le démarrage du dashboard, ${formatRelativeAgeFr(uptimeMs)}`;
  }
  return `sur les ${formatElapsed(journal.retentionMs)} écoulées`;
}

/** Chronologie d'une entrée. `stale` retire la prétention au présent : sur un
 *  flux de statut interrompu, plus rien ne soutient un « en cours ». */
function timingText(entry: AnomalyEntry, stale: boolean): string {
  if (entry.endedAt === null) {
    return `depuis ${clock(entry.startedAt)} · ${stale ? "en cours à la dernière mesure" : "en cours"}`;
  }
  const duration = formatElapsed(entry.endedAt - entry.startedAt);
  // Un épisode court commence et finit dans la même minute : « 18:58 → 18:58 »
  // n'apprendrait rien, la durée le dit déjà.
  const start = clock(entry.startedAt);
  const end = clock(entry.endedAt);
  return start === end ? `${start} · ${duration}` : `${start} → ${end} · ${duration}`;
}

function EntryRow({ entry, stale }: { entry: AnomalyEntry; stale: boolean }) {
  const severity = SEVERITY[entry.severity];
  return (
    <li className="flex items-start gap-2.5 border-t border-white/6 px-4 py-2.5 sm:px-5">
      {/* Pastille atténuée quand l'anomalie est refermée : même traitement que
          les cartes sur une mesure périmée (StatusCard), la couleur pleine
          n'affirme que ce qui est encore vrai. La chronologie de la ligne
          reste le signal qui fait foi. */}
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: severity.dot, opacity: entry.endedAt === null ? undefined : 0.4 }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-[var(--text-primary)] sm:text-sm">
          <span className="mr-1.5 align-middle text-2xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {entry.scope}
          </span>
          <span className="break-words">{entry.label}</span>
        </p>
        {/* La sévérité est écrite, pas seulement colorée (UI_UX §4) : la pastille
            ne porte jamais seule la différence entre panne et dégradation. */}
        <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-2xs text-[var(--text-muted)]">
          <span>{severity.noun}</span>
          <span aria-hidden>·</span>
          <span>{timingText(entry, stale)}</span>
          {entry.occurrences > 1 && (
            <>
              <span aria-hidden>·</span>
              {/* Le compteur remplace une pile de lignes identiques : une sonde
                  qui clignote reste UNE anomalie, dont on dit la récurrence. */}
              <span>{entry.occurrences} occurrences</span>
            </>
          )}
        </p>
        {entry.detail && (
          <p className="mt-0.5 break-words text-2xs text-[var(--text-muted)]">{entry.detail}</p>
        )}
      </div>
    </li>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Anomalies récentes"
      className="mb-4 overflow-hidden rounded-xl border border-white/8 bg-[var(--surface-panel)]"
    >
      {children}
    </section>
  );
}

/** En-tête du panneau. Le micro-libellé de catégorie est INLINE dans la phrase,
 *  comme celui du diagnostic réseau : posé en colonne flex à côté d'elle, il
 *  réduisait le texte à un boyau de 150 px à 320 px de large. */
function Headline({ symbol, headline, secondary }: { symbol: string; headline: ReactNode; secondary?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 text-xs text-[var(--text-secondary)] sm:text-sm">
      <h2 className="mr-2 inline align-middle text-2xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
        Anomalies
      </h2>
      <span className="mr-1.5 text-[var(--text-muted)]" aria-hidden>
        {symbol}
      </span>
      {headline}
      {secondary && <p className="mt-1 text-2xs text-[var(--text-muted)]">{secondary}</p>}
    </div>
  );
}

export function AnomalyStrip({
  journal,
  hasStatus,
  stale,
}: {
  journal: AnomalyJournal | undefined;
  /** Vrai dès qu'un instantané est arrivé : distingue « pas encore de donnée »
   *  d'un backend qui ne tient pas ce journal. */
  hasStatus: boolean;
  stale: boolean;
}) {
  // Le journal est un historique : ses durées se comptent en minutes, un
  // rafraîchissement par seconde ne ferait que re-rendre douze lignes pour
  // rien. L'instantané SSE, lui, arrive de toute façon toutes les 5 s.
  const now = useNow(10_000);
  const [open, setOpen] = useState(false);

  if (!journal) {
    return (
      <Shell>
        <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
          <Headline
            symbol="…"
            headline={
              hasStatus
                ? "Ce backend ne tient pas de journal d'anomalies : une panne passée n'y laisse aucune trace."
                : "En attente du premier instantané de statut."
            }
          />
        </div>
      </Shell>
    );
  }

  const entries = journal.entries;
  const ongoing = entries.filter((entry) => entry.endedAt === null).length;

  if (entries.length === 0) {
    return (
      <Shell>
        <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
          {/* Pas de vert ni de « ✓ » : la fenêtre observée peut ne faire que
              deux minutes. On énonce l'absence de trace et son étendue, ce
              n'est pas la même affirmation que « tout va bien ». */}
          <Headline symbol="○" headline={`Aucune anomalie observée ${windowText(journal, now)}.`} />
        </div>
      </Shell>
    );
  }

  const latest = entries[0]!;
  // Les entrées en cours sont en tête : `latest` est donc la plus récente des
  // anomalies actives s'il y en a, sinon la dernière refermée.
  const secondary =
    ongoing > 0
      ? `${ongoing} en cours · la plus récente : ${latest.label}`
      : `Dernière : ${latest.label} · résolue ${formatRelativeAgeFr(Math.max(0, now - (latest.endedAt ?? latest.lastSeenAt)))}`;

  return (
    <Shell>
      <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
        {/* Replié, le compte, la fenêtre observée et la dernière anomalie
            restent lisibles : le but du journal est qu'un incident résolu se
            voie SANS avoir à ouvrir quoi que ce soit.
            aria-live absent volontairement — les âges se recalculent seuls et
            annonceraient la même phrase en boucle (même raison que FreshnessBadge). */}
        <Headline
          symbol={ongoing > 0 ? "!" : "○"}
          headline={`${entries.length} anomalie${entries.length > 1 ? "s" : ""} ${windowText(journal, now)}.`}
          secondary={secondary}
        />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="min-h-10 shrink-0 rounded-lg border border-white/8 bg-black/20 px-2.5 text-2xs text-[var(--text-secondary)] transition-colors hover:bg-white/6 sm:min-h-8"
        >
          {open ? "Masquer" : "Détail"}
        </button>
      </div>

      {open && (
        <>
          <ul>
            {entries.map((entry) => (
              // Une même clé peut réapparaître après la fenêtre de regroupement
              // (nouvel épisode) : c'est le couple clé + début qui identifie
              // une entrée.
              <EntryRow key={`${entry.key}-${entry.startedAt}`} entry={entry} stale={stale} />
            ))}
          </ul>
          <p className="border-t border-white/6 px-4 py-2.5 text-2xs leading-4 text-[var(--text-muted)] sm:px-5">
            Journal tenu en mémoire par le backend, jamais écrit sur disque : il repart vide à
            chaque redémarrage du dashboard et ne conserve rien au-delà de{" "}
            {formatElapsed(journal.retentionMs)}. Ce n'est pas un historique complet.
          </p>
        </>
      )}
    </Shell>
  );
}
