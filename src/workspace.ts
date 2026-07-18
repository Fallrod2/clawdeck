// src/workspace.ts — écriture confinée de fichiers dans le workspace de
// l'agent OpenClaw. La LECTURE passe par la gateway (agents.workspace.*,
// operator.read) ; l'ÉCRITURE se fait ici en direct sur le disque, car
// agents.files.set exigerait operator.admin qu'on ne demande pas (moindre
// privilège, voir gateway/client.ts). Toute la logique est pure et testée :
// c'est la seule surface du dashboard qui modifie l'état de la machine.

import { mkdirSync, realpathSync, statSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

// 10 Mo utiles : assez pour des notes, docs et images de travail, assez petit
// pour qu'un upload ne devienne jamais un vecteur de saturation disque.
export const MAX_WORKSPACE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REL_PATH_LENGTH = 256;

export type WorkspaceWriteCode = "invalid-path" | "too-large" | "exists" | "root-unavailable";

export class WorkspaceWriteError extends Error {
  constructor(
    readonly code: WorkspaceWriteCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceWriteError";
  }
}

// Normalise et valide un chemin RELATIF au workspace. Retourne null pour tout
// ce qui pourrait sortir du confinement ou toucher au dépôt git du workspace :
// vide, absolu, backslash, caractères de contrôle, segments «..»/«.», .git.
export function sanitizeWorkspaceRelPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_REL_PATH_LENGTH) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  if (trimmed.includes("\\")) return null;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null; // caractères de contrôle
  }

  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
  }
  // Le dépôt git interne du workspace est intouchable, à la racine comme en
  // sous-dossier (un hook déposé dans .git/hooks serait exécuté par git).
  if (segments.some((s) => s === ".git")) return null;
  return segments.join("/");
}

// Écrit `data` sous `root/relPath` (0644), en créant les sous-dossiers.
// Défense en profondeur : après sanitisation ET création des dossiers, le
// parent RÉSOLU (realpath, symlinks suivis) doit rester sous realpath(root) —
// un symlink présent dans le workspace ne permet donc pas d'écrire dehors.
export async function saveWorkspaceFile(
  root: string,
  relPath: string,
  data: Uint8Array,
  overwrite: boolean,
): Promise<{ path: string; bytes: number }> {
  const clean = sanitizeWorkspaceRelPath(relPath);
  if (!clean) {
    throw new WorkspaceWriteError("invalid-path", "chemin invalide ou hors du workspace");
  }
  if (data.byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw new WorkspaceWriteError(
      "too-large",
      `fichier trop volumineux (max ${Math.round(MAX_WORKSPACE_FILE_BYTES / 1024 / 1024)} Mo)`,
    );
  }
  if (data.byteLength === 0) {
    throw new WorkspaceWriteError("invalid-path", "contenu vide");
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(root);
    if (!statSync(resolvedRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WorkspaceWriteError("root-unavailable", "workspace introuvable sur le disque");
  }

  const target = join(resolvedRoot, clean);
  const parent = dirname(target);
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    throw new WorkspaceWriteError("root-unavailable", "impossible de créer le dossier cible");
  }

  // realpath du parent APRÈS création : si un segment traversé est un symlink
  // qui sort du workspace, le préfixe ne correspond plus → refus.
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync(parent);
  } catch {
    throw new WorkspaceWriteError("root-unavailable", "dossier cible illisible");
  }
  if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(resolvedRoot + sep)) {
    throw new WorkspaceWriteError("invalid-path", "chemin résolu hors du workspace (symlink)");
  }

  const finalPath = join(resolvedParent, clean.split("/").pop()!);
  if (!overwrite && existsSync(finalPath)) {
    throw new WorkspaceWriteError("exists", "un fichier existe déjà à ce chemin");
  }
  // Ne jamais écraser un dossier ou un lien, même avec overwrite.
  if (existsSync(finalPath) && !statSync(finalPath).isFile()) {
    throw new WorkspaceWriteError("invalid-path", "la cible n'est pas un fichier ordinaire");
  }

  writeFileSync(finalPath, data, { mode: 0o644 });
  return { path: clean, bytes: data.byteLength };
}
