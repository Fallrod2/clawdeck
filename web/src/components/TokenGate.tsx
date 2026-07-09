// src/components/TokenGate.tsx — saisie du bearer token (AUTH_TOKEN backend).

import { useState } from "react";

export function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        className="w-full max-w-sm rounded-lg border border-white/10 bg-neutral-900 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1 className="mb-1 text-lg font-semibold">clawdeck</h1>
        <p className="mb-4 text-sm text-neutral-400">
          Token d'accès (AUTH_TOKEN du backend, voir .env).
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-white/30"
          placeholder="••••••••"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-md bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20"
        >
          Se connecter
        </button>
      </form>
    </div>
  );
}
