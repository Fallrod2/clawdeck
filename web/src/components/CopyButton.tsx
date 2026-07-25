// src/components/CopyButton.tsx — copie d'un contenu vers le presse-papiers,
// avec accusé discret (UI_UX.md §6 : pas de toast quand le résultat est
// visible sur place). Toujours dans l'ordre de tabulation même quand il est
// visuellement estompé : un contrôle ne doit pas dépendre du survol
// (UI_UX.md §7).

import { useEffect, useState } from "react";
import { copyText } from "../lib/clipboard";

type CopyState = "idle" | "ok" | "error";

const FEEDBACK_MS = 2_000;

export function CopyButton({
  getText,
  label,
  className = "",
}: {
  /** Évalué au clic : le texte peut changer entre deux rendus (streaming). */
  getText: () => string;
  /** Libellé accessible, ex. « Copier le message ». */
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      onClick={async () => {
        setState((await copyText(getText())) ? "ok" : "error");
      }}
      // L'état est porté par le libellé lui-même, annoncé au changement.
      aria-live="polite"
      aria-label={state === "idle" ? label : undefined}
      className={`min-h-7 rounded-md border px-2 text-[10px] transition focus-visible:opacity-100 active:scale-[0.97] ${
        state === "error"
          ? "border-red-300/25 bg-red-300/10 text-red-200"
          : state === "ok"
            ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-200"
            : "border-white/12 bg-black/20 text-[var(--text-secondary)] hover:bg-white/8"
      } ${className}`}
    >
      {state === "ok" ? "✓ Copié" : state === "error" ? "Copie impossible" : "Copier"}
    </button>
  );
}
