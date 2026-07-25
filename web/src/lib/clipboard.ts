// src/lib/clipboard.ts — copie presse-papiers utilisable ICI.
//
// navigator.clipboard n'existe QUE dans un contexte sécurisé (HTTPS ou
// localhost). Le dashboard est servi en http:// sur l'IP Tailscale : l'API
// moderne y est purement absente — même contrainte que crypto.randomUUID,
// contournée dans hooks/useChat.ts. D'où la retombée sur execCommand,
// déprécié mais seul chemin disponible dans ce déploiement.

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Contexte non sécurisé ou permission refusée : on tente la retombée
    // plutôt que d'abandonner.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // Hors écran mais réellement sélectionnable : execCommand exige une
    // sélection effective, un élément display:none ne fonctionnerait pas.
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
