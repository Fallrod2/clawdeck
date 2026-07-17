// src/components/TokenGate.tsx — accès mono-utilisateur au dashboard privé.

import { useState } from "react";

export function TokenGate({
  onSubmit,
  error,
}: {
  onSubmit: (token: string) => void;
  error?: string | null;
}) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_10%,rgba(101,214,189,0.09),transparent_32rem)]" />

      <div className="relative w-full max-w-md">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-300/15 bg-emerald-300/8 font-mono text-sm font-semibold text-emerald-200 shadow-[0_16px_50px_rgba(0,0,0,0.35)]">
            cd
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">clawdeck</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Console privée de supervision OpenClaw
          </p>
        </div>

        <form
          className="rounded-2xl border border-white/9 bg-[var(--surface-panel)] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-white/7 bg-white/3 px-3.5 py-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-300/10 text-xs text-emerald-200" aria-hidden>
              ✓
            </span>
            <div>
              <p className="text-xs font-medium text-[var(--text-primary)]">Accès privé</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                Le token reste dans ce navigateur et n'est envoyé qu'à ton instance clawdeck.
              </p>
            </div>
          </div>

          <label htmlFor="auth-token" className="text-xs font-medium text-[var(--text-secondary)]">
            Token d'accès
          </label>
          <div className="relative mt-2">
            <input
              id="auth-token"
              type={visible ? "text" : "password"}
              autoFocus
              autoComplete="current-password"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "token-error" : "token-help"}
              className="min-h-12 w-full rounded-xl border border-white/10 bg-black/20 px-3.5 pr-20 font-mono text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-emerald-300/35"
              placeholder="AUTH_TOKEN"
            />
            <button
              type="button"
              className="absolute inset-y-1 right-1 min-w-16 rounded-lg px-2 text-xs text-[var(--text-muted)] transition-colors hover:bg-white/5 hover:text-[var(--text-secondary)]"
              onClick={() => setVisible((current) => !current)}
              aria-label={visible ? "Masquer le token" : "Afficher le token"}
            >
              {visible ? "Masquer" : "Afficher"}
            </button>
          </div>

          {error ? (
            <p id="token-error" role="alert" className="mt-2 text-xs leading-5 text-red-300">
              {error}
            </p>
          ) : (
            <p id="token-help" className="mt-2 text-xs text-[var(--text-muted)]">
              Valeur AUTH_TOKEN définie dans le fichier .env du serveur.
            </p>
          )}

          <button
            type="submit"
            disabled={!value.trim()}
            className="mt-5 min-h-12 w-full rounded-xl bg-emerald-300 px-4 text-sm font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Ouvrir le dashboard
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-[var(--text-muted)]">
          Connexion protégée par bearer token · accès tailnet uniquement
        </p>
      </div>
    </main>
  );
}
