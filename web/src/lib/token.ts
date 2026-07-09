// src/lib/token.ts — stockage local du bearer token.
// Le dashboard n'est accessible que via Tailscale (voir CLAUDE.md) : localStorage
// suffit, pas besoin d'un flux OAuth pour un dashboard mono-utilisateur.

const KEY = "clawdeck.token";

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}

export function setToken(token: string) {
  localStorage.setItem(KEY, token);
}

export function clearToken() {
  localStorage.removeItem(KEY);
}
