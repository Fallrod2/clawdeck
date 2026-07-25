// src/components/UsageCard.tsx — consommation et quotas des fournisseurs.
//
// Ce que ce panneau doit dire, et pourquoi il est délicat : le blocage d'un
// agent ne vient pas d'une moyenne mais de la fenêtre la PLUS consommée, et
// la valorisation du coût produite par OpenClaw n'est pas une facture. Deux
// occasions de mentir avec des chiffres justes, que le rendu doit refuser.

import type { CostUsage, OpenClawUsage, QuotaUsage, UsageProvider } from "../lib/types";

// Seuils d'alerte sur une fenêtre de quota. Volontairement hauts : un
// avertissement à 50 % serait ignoré au bout d'une semaine.
const QUOTA_WARNING = 75;
const QUOTA_CRITICAL = 90;

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(".", ",")} M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)} k`;
  return String(count);
}

// Délai avant remise à zéro d'une fenêtre. C'est l'information qui décide
// s'il faut lever le pied maintenant ou si le quota se libère dans l'heure.
function formatReset(resetAt: number | null, now: number): string | null {
  if (resetAt === null) return null;
  const ms = resetAt - now;
  if (ms <= 0) return "remise à zéro imminente";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `réarmée dans ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `réarmée dans ${hours} h`;
  return `réarmée dans ${Math.round(hours / 24)} j`;
}

function ProviderRow({ provider, now }: { provider: UsageProvider; now: number }) {
  // La fenêtre affichée est celle qui décide du blocage, pas la première
  // déclarée par le fournisseur.
  const worst =
    provider.windows.length > 0
      ? provider.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
      : null;
  const percent = provider.worstUsedPercent ?? worst?.usedPercent ?? null;
  const tone =
    percent === null
      ? "text-[var(--text-muted)]"
      : percent >= QUOTA_CRITICAL
        ? "text-[var(--status-critical)]"
        : percent >= QUOTA_WARNING
          ? "text-[var(--status-warning)]"
          : "text-[var(--text-secondary)]";
  const bar =
    percent === null
      ? "bg-[var(--border-strong)]"
      : percent >= QUOTA_CRITICAL
        ? "bg-[var(--status-critical)]"
        : percent >= QUOTA_WARNING
          ? "bg-[var(--status-warning)]"
          : "bg-[var(--accent)]";
  const reset = formatReset(worst?.resetAt ?? null, now);

  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-medium text-[var(--text-primary)]">{provider.displayName}</span>
        {provider.plan && (
          <span className="rounded-full border border-[var(--border-subtle)] px-1.5 text-2xs text-[var(--text-muted)]">
            {provider.plan}
          </span>
        )}
        {worst && <span className="font-mono text-2xs text-[var(--text-muted)]">{worst.label}</span>}
        <span className={`ml-auto text-xs font-semibold tabular-nums ${tone}`}>
          {percent === null ? "—" : `${percent} %`}
        </span>
      </div>

      {provider.error ? (
        <p className="text-2xs text-red-300">{provider.error}</p>
      ) : (
        <>
          {/* La barre double le pourcentage, elle ne le remplace pas : une
              couleur seule ne porte jamais un statut (UI_UX.md §4). */}
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-black/40"
            role="img"
            aria-label={`${provider.displayName} : ${percent ?? 0} % consommés${reset ? `, ${reset}` : ""}`}
          >
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
          </div>
          {reset && <p className="text-2xs text-[var(--text-muted)]">{reset}</p>}
        </>
      )}
    </li>
  );
}

function QuotaSection({ quota, now }: { quota: QuotaUsage; now: number }) {
  if (quota.state === "error") {
    return <p className="text-2xs text-red-300">Quotas illisibles : {quota.error ?? "cause inconnue"}</p>;
  }
  if (quota.state === "pending") {
    return <p className="text-2xs text-[var(--text-muted)]">Première lecture des quotas en cours.</p>;
  }
  if (quota.state === "empty" || quota.providers.length === 0) {
    return <p className="text-2xs text-[var(--text-muted)]">Aucun fournisseur ne déclare de quota.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--border-subtle)]">
      {quota.providers.map((provider) => (
        <ProviderRow key={provider.id} provider={provider} now={now} />
      ))}
    </ul>
  );
}

function CostSection({ cost }: { cost: CostUsage }) {
  if (cost.state === "error") {
    return <p className="text-2xs text-red-300">Consommation illisible : {cost.error ?? "cause inconnue"}</p>;
  }
  if (cost.state === "pending") {
    // Les totaux valent zéro par CONSTRUCTION tant que le cache se
    // reconstruit : les afficher donnerait à croire qu'il ne s'est rien passé.
    return <p className="text-2xs text-[var(--text-muted)]">Calcul de consommation en cours.</p>;
  }

  // `totalCost` n'est pas une facture mais une valorisation calculée depuis
  // la table de tarifs d'OpenClaw. Avec des entrées non tarifées, ce n'est
  // même plus un total : c'est un plancher. On préfère alors ne rien
  // chiffrer plutôt qu'annoncer un montant faux.
  const chiffrable = cost.missingCostEntries === 0 && cost.totalCost > 0;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-[var(--text-secondary)]">
        <span className="font-semibold tabular-nums text-[var(--text-primary)]">
          {formatTokens(cost.totalTokens)}
        </span>{" "}
        jetons sur {cost.windowDays} jours
      </p>
      <p className="font-mono text-2xs text-[var(--text-muted)]">
        {formatTokens(cost.inputTokens)} entrée · {formatTokens(cost.outputTokens)} sortie ·{" "}
        {formatTokens(cost.cacheReadTokens)} cache
      </p>
      {chiffrable ? (
        <p className="text-2xs text-[var(--text-muted)]">
          Valorisation OpenClaw : {cost.totalCost.toFixed(2).replace(".", ",")} — estimation depuis sa
          table de tarifs, pas une facture.
        </p>
      ) : (
        <p className="text-2xs text-[var(--text-muted)]">
          {cost.missingCostEntries > 0
            ? `Valorisation impossible : ${cost.missingCostEntries} entrées sans tarif connu.`
            : "Aucune valorisation disponible."}
        </p>
      )}
      {cost.freshness === "stale" && (
        <p className="text-2xs text-amber-200/85">Cache de calcul périmé côté OpenClaw.</p>
      )}
    </div>
  );
}

export function UsageCard({ usage, now }: { usage: OpenClawUsage | undefined; now: number }) {
  // Rien à attendre : ni bloc vide, ni « en attente » perpétuel. Un backend
  // plus ancien ou une gateway qui n'annonce pas ces méthodes ne doit pas
  // laisser une carte fantôme dans la vue.
  if (!usage) return null;
  if (usage.quota.state === "unsupported" && usage.cost.state === "unsupported") return null;

  return (
    <section
      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 sm:p-5"
      aria-label="Consommation et quotas"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Consommation</h2>
        <p className="text-2xs text-[var(--text-muted)]">Mesuré par OpenClaw</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
        <div>
          <p className="mb-1 text-2xs font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Quotas fournisseurs
          </p>
          {usage.quota.state === "unsupported" ? (
            <p className="text-2xs text-[var(--text-muted)]">Non exposés par cette gateway.</p>
          ) : (
            <QuotaSection quota={usage.quota} now={now} />
          )}
        </div>
        <div>
          <p className="mb-1 text-2xs font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Jetons consommés
          </p>
          {usage.cost.state === "unsupported" ? (
            <p className="text-2xs text-[var(--text-muted)]">Non exposée par cette gateway.</p>
          ) : (
            <CostSection cost={usage.cost} />
          )}
        </div>
      </div>
    </section>
  );
}
