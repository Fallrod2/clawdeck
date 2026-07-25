// src/media.ts — lecture confinée d'un média reçu par l'agent.
//
// Les messages venus de WhatsApp portent un chemin ABSOLU vers le fichier
// reçu (`MediaPath`, ex. .../workspace/media/inbound/…/x.ogg). Sans ce module,
// une photo ou un vocal envoyé depuis le téléphone n'apparaît dans le
// dashboard que sous la forme « média envoyé, sans légende ».
//
// Le chemin arrive par le navigateur : il n'est JAMAIS digne de confiance,
// même s'il provient à l'origine de la gateway. La garde est donc la même que
// pour l'écriture (src/workspace.ts) : résolution par `realpath` des deux
// côtés, puis vérification que le fichier résolu est bien SOUS la racine
// résolue du workspace — ce qui neutralise à la fois les « .. » et les
// symlinks d'évasion.

import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";

export type MediaReadCode = "invalid-path" | "outside-workspace" | "not-found" | "too-large";

export class MediaReadError extends Error {
  constructor(readonly code: MediaReadCode, message: string) {
    super(message);
    this.name = "MediaReadError";
  }
}

// Un média reçu par messagerie ne pèse pas des centaines de mégaoctets ; cette
// borne protège surtout la mémoire du process contre un chemin pointant vers
// un gros fichier quelconque du workspace.
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

// Types servis tels quels. Tout le reste est renvoyé en octets neutres :
// laisser le navigateur interpréter un type arbitraire, c'est lui offrir un
// vecteur de rendu que rien n'a validé.
const SERVABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

/**
 * Normalise le type déclaré par OpenClaw (« audio/ogg; codecs=opus ») et ne
 * retient que ce qu'on accepte de servir avec son vrai type.
 */
export function safeMediaType(declared: string | null | undefined): string {
  const base = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return SERVABLE_TYPES.has(base) ? base : "application/octet-stream";
}

/**
 * Résout un chemin de média sous la racine du workspace, ou lève.
 * `root` est la racine annoncée par la gateway pour l'agent courant.
 */
export function resolveMediaPath(root: string, requested: string): string {
  if (!requested || requested.includes("\0")) {
    throw new MediaReadError("invalid-path", "chemin de média invalide");
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(root);
  } catch {
    throw new MediaReadError("not-found", "racine du workspace introuvable");
  }

  let resolved: string;
  try {
    resolved = realpathSync(requested);
  } catch {
    throw new MediaReadError("not-found", "média introuvable");
  }

  // Comparaison sur le chemin RÉSOLU, et avec un séparateur final : sans lui,
  // « /w/media-secret » passerait la garde d'une racine « /w/media ».
  const prefixe = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefixe)) {
    throw new MediaReadError("outside-workspace", "média hors du workspace de l'agent");
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new MediaReadError("not-found", "le chemin ne désigne pas un fichier");
  }
  if (stat.size > MAX_MEDIA_BYTES) {
    throw new MediaReadError("too-large", "média trop volumineux pour être servi");
  }
  return resolved;
}
