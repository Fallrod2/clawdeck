// src/components/FilesPanel.tsx — onglet Fichiers : parcourir le workspace de
// l'agent (lecture via gateway) et y déposer des fichiers (écriture locale
// confinée). Chaque action suit le pattern pending → accusé → échec (UI_UX §5).

import { useEffect, useRef, useState } from "react";
import { useWorkspace, type WorkspaceEntry } from "../hooks/useWorkspace";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // aligné sur MAX_WORKSPACE_FILE_BYTES

function formatBytes(size?: number): string {
  if (size === undefined) return "—";
  if (size < 1024) return `${size} o`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} Ko`;
  return `${(size / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDateFr(timestamp?: number): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// État d'une action d'écriture, affiché sous son formulaire.
type ActionStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function StatusLine({ status }: { status: ActionStatus }) {
  if (status.kind === "idle") return null;
  const style =
    status.kind === "pending"
      ? "text-[var(--text-muted)]"
      : status.kind === "success"
        ? "text-emerald-300"
        : "text-red-300";
  const text =
    status.kind === "pending" ? "Envoi en cours…" : status.message;
  return (
    <p className={`mt-2 text-xs ${style}`} role="status">
      {text}
    </p>
  );
}

export function FilesPanel({ token, active }: { token: string | null; active: boolean }) {
  const ws = useWorkspace(token);
  const [uploadStatus, setUploadStatus] = useState<ActionStatus>({ kind: "idle" });
  const [createStatus, setCreateStatus] = useState<ActionStatus>({ kind: "idle" });
  const [uploadOverwrite, setUploadOverwrite] = useState(false);
  const [createOverwrite, setCreateOverwrite] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFileText, setNewFileText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasActive = useRef(false);

  // Au retour sur l'onglet, on resynchronise le listing (le workspace a pu
  // changer côté agent pendant qu'on regardait ailleurs).
  useEffect(() => {
    if (active && !wasActive.current) ws.refresh();
    wasActive.current = active;
  }, [active, ws]);

  const crumbs = ws.path ? ws.path.split("/") : [];

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = fileInputRef.current;
    const file = input?.files?.[0];
    if (!file) {
      setUploadStatus({ kind: "error", message: "Choisis un fichier d'abord." });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadStatus({ kind: "error", message: "Fichier trop volumineux (max 10 Mo)." });
      return;
    }
    setUploadStatus({ kind: "pending" });
    const base64 = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (base64 === null) {
      setUploadStatus({ kind: "error", message: "Lecture du fichier impossible." });
      return;
    }
    const destination = ws.path ? `${ws.path}/${file.name}` : file.name;
    const result = await ws.saveFile({
      path: destination,
      contentBase64: base64,
      overwrite: uploadOverwrite,
    });
    if (result.ok) {
      setUploadStatus({ kind: "success", message: `Déposé : ${result.path} (${formatBytes(result.bytes)})` });
      if (input) input.value = "";
      setUploadOverwrite(false);
    } else {
      setUploadStatus({
        kind: "error",
        message:
          result.code === "exists"
            ? "Un fichier existe déjà à ce chemin — coche « écraser » pour le remplacer."
            : `Échec : ${result.error}`,
      });
    }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newFileName.trim();
    if (!name) {
      setCreateStatus({ kind: "error", message: "Donne un nom de fichier." });
      return;
    }
    if (!newFileText) {
      setCreateStatus({ kind: "error", message: "Le contenu est vide." });
      return;
    }
    setCreateStatus({ kind: "pending" });
    const destination = ws.path ? `${ws.path}/${name}` : name;
    const result = await ws.saveFile({
      path: destination,
      contentText: newFileText,
      overwrite: createOverwrite,
    });
    if (result.ok) {
      setCreateStatus({ kind: "success", message: `Créé : ${result.path}` });
      setNewFileName("");
      setNewFileText("");
      setCreateOverwrite(false);
    } else {
      setCreateStatus({
        kind: "error",
        message:
          result.code === "exists"
            ? "Un fichier existe déjà à ce chemin — coche « écraser » pour le remplacer."
            : `Échec : ${result.error}`,
      });
    }
  }

  const isImage =
    ws.preview?.encoding === "base64" && (ws.preview.mimeType ?? "").startsWith("image/");

  return (
    <div className="overflow-hidden rounded-xl border border-white/8 bg-[var(--surface-panel)]">
      {/* Fil d'Ariane + actualisation */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/7 px-4 py-3 sm:px-5">
        <nav aria-label="Chemin dans le workspace" className="flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => ws.navigateTo("")}
            className={`rounded px-1.5 py-0.5 hover:bg-white/6 focus-visible:outline focus-visible:outline-emerald-300/60 ${
              ws.path ? "text-[var(--text-secondary)]" : "font-medium text-white"
            }`}
          >
            Workspace
          </button>
          {crumbs.map((segment, i) => {
            const target = crumbs.slice(0, i + 1).join("/");
            const isLast = i === crumbs.length - 1;
            return (
              <span key={target} className="flex items-center gap-1">
                <span aria-hidden className="text-[var(--text-muted)]">/</span>
                <button
                  type="button"
                  onClick={() => ws.navigateTo(target)}
                  aria-current={isLast ? "location" : undefined}
                  className={`rounded px-1.5 py-0.5 hover:bg-white/6 focus-visible:outline focus-visible:outline-emerald-300/60 ${
                    isLast ? "font-medium text-white" : "text-[var(--text-secondary)]"
                  }`}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={ws.refresh}
          className="rounded-lg border border-white/8 px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:bg-white/6 focus-visible:outline focus-visible:outline-emerald-300/60"
        >
          Actualiser
        </button>
      </div>

      {/* Ajout de fichiers */}
      <div className="grid grid-cols-1 gap-3 border-b border-white/7 px-4 py-3 sm:px-5 lg:grid-cols-2">
        <details className="rounded-lg border border-white/8 bg-black/15 px-3 py-2">
          <summary className="cursor-pointer text-sm text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-emerald-300/60">
            Téléverser un fichier
          </summary>
          <form onSubmit={handleUpload} className="mt-3 flex flex-col gap-2">
            <label className="text-xs text-[var(--text-muted)]" htmlFor="ws-upload-file">
              Fichier (max 10 Mo), déposé dans le dossier courant
            </label>
            <input
              id="ws-upload-file"
              ref={fileInputRef}
              type="file"
              className="text-xs text-[var(--text-secondary)] file:mr-3 file:rounded-lg file:border-0 file:bg-white/9 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:bg-white/14"
            />
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={uploadOverwrite}
                onChange={(e) => setUploadOverwrite(e.target.checked)}
              />
              Écraser si le fichier existe déjà
            </label>
            <button
              type="submit"
              disabled={uploadStatus.kind === "pending"}
              className="w-fit rounded-lg bg-emerald-400/15 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-400/22 disabled:opacity-50 focus-visible:outline focus-visible:outline-emerald-300/60"
            >
              {uploadStatus.kind === "pending" ? "Envoi en cours…" : "Déposer"}
            </button>
            <StatusLine status={uploadStatus} />
          </form>
        </details>

        <details className="rounded-lg border border-white/8 bg-black/15 px-3 py-2">
          <summary className="cursor-pointer text-sm text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-emerald-300/60">
            Nouveau fichier texte
          </summary>
          <form onSubmit={handleCreate} className="mt-3 flex flex-col gap-2">
            <label className="text-xs text-[var(--text-muted)]" htmlFor="ws-new-name">
              Nom (dans le dossier courant, ex. notes.md)
            </label>
            <input
              id="ws-new-name"
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="notes.md"
              className="rounded-lg border border-white/8 bg-black/20 px-2.5 py-1.5 text-sm text-white placeholder:text-[var(--text-muted)] focus-visible:outline focus-visible:outline-emerald-300/60"
            />
            <label className="text-xs text-[var(--text-muted)]" htmlFor="ws-new-content">
              Contenu
            </label>
            <textarea
              id="ws-new-content"
              value={newFileText}
              onChange={(e) => setNewFileText(e.target.value)}
              rows={4}
              className="rounded-lg border border-white/8 bg-black/20 px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-[var(--text-muted)] focus-visible:outline focus-visible:outline-emerald-300/60"
              placeholder="Une note, des instructions, un contexte pour l'agent…"
            />
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={createOverwrite}
                onChange={(e) => setCreateOverwrite(e.target.checked)}
              />
              Écraser si le fichier existe déjà
            </label>
            <button
              type="submit"
              disabled={createStatus.kind === "pending"}
              className="w-fit rounded-lg bg-emerald-400/15 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-400/22 disabled:opacity-50 focus-visible:outline focus-visible:outline-emerald-300/60"
            >
              {createStatus.kind === "pending" ? "Envoi en cours…" : "Créer"}
            </button>
            <StatusLine status={createStatus} />
          </form>
        </details>
      </div>

      {/* Listing */}
      <div className="px-4 py-3 sm:px-5">
        {ws.listingState === "offline" && (
          <p className="rounded-lg border border-amber-300/12 bg-amber-300/6 px-3 py-2 text-sm text-amber-200">
            Gateway déconnectée — le workspace sera relu à la reconnexion.
          </p>
        )}
        {ws.listingState === "auth" && (
          <p className="rounded-lg border border-red-300/12 bg-red-300/6 px-3 py-2 text-sm text-red-200">
            Authentification requise — recharger la page.
          </p>
        )}
        {ws.listingState === "error" && (
          <p className="rounded-lg border border-red-300/12 bg-red-300/6 px-3 py-2 text-sm text-red-200">
            Lecture impossible : {ws.listingError}
          </p>
        )}
        {ws.listingState === "loading" && (
          <p className="px-1 py-2 text-sm text-[var(--text-muted)]">Chargement du dossier…</p>
        )}
        {ws.listingState === "ready" && ws.entries.length === 0 && (
          <p className="px-1 py-2 text-sm text-[var(--text-muted)]">Dossier vide.</p>
        )}
        {ws.listingState === "ready" && ws.entries.length > 0 && (
          <ul className="divide-y divide-white/5">
            {ws.entries.map((entry: WorkspaceEntry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() =>
                    entry.kind === "directory" ? ws.navigateTo(entry.path) : ws.openFile(entry.path)
                  }
                  className="flex w-full items-center gap-3 rounded px-1.5 py-2 text-left hover:bg-white/4 focus-visible:outline focus-visible:outline-emerald-300/60"
                >
                  <span aria-hidden className="w-4 shrink-0 text-center text-[var(--text-muted)]">
                    {entry.kind === "directory" ? "▸" : "·"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-secondary)]">
                    {entry.name}
                    {entry.kind === "directory" && <span aria-hidden>/</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                    {entry.kind === "file" ? formatBytes(entry.size) : ""}
                  </span>
                  <span className="hidden shrink-0 font-mono text-[11px] text-[var(--text-muted)] sm:inline">
                    {formatDateFr(entry.updatedAtMs)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Prévisualisation */}
      {(ws.preview || ws.previewState !== "idle") && (
        <div className="border-t border-white/7 px-4 py-3 sm:px-5">
          {ws.previewState === "loading" && (
            <p className="text-sm text-[var(--text-muted)]">Ouverture du fichier…</p>
          )}
          {ws.previewState === "error" && (
            <p className="text-sm text-red-300">Prévisualisation impossible : {ws.previewError}</p>
          )}
          {ws.preview && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium text-white">{ws.preview.path}</p>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {formatBytes(ws.preview.size)} · modifié {formatDateFr(ws.preview.updatedAtMs)}
                  </span>
                  <button
                    type="button"
                    onClick={ws.closePreview}
                    className="rounded-lg border border-white/8 px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-white/6 focus-visible:outline focus-visible:outline-emerald-300/60"
                  >
                    Fermer
                  </button>
                </div>
              </div>
              {isImage ? (
                <img
                  src={`data:${ws.preview.mimeType};base64,${ws.preview.content}`}
                  alt={`Aperçu de ${ws.preview.name}`}
                  className="max-h-96 max-w-full rounded-lg border border-white/8"
                />
              ) : ws.preview.encoding === "base64" ? (
                <p className="text-sm text-[var(--text-muted)]">
                  Contenu binaire ({ws.preview.mimeType ?? "type inconnu"}) — pas d'aperçu texte.
                </p>
              ) : (
                <pre className="max-h-96 overflow-auto rounded-lg border border-white/8 bg-black/25 p-3 font-mono text-xs leading-5 text-[var(--text-secondary)]">
                  {ws.preview.content}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
