// src/hooks/useWorkspace.ts — navigation dans le workspace de l'agent
// OpenClaw (lecture relayée par la gateway) et ajout de fichiers (écriture
// locale confinée côté backend). Chemins toujours RELATIFS au workspace.

import { useCallback, useEffect, useRef, useState } from "react";

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "directory" | "file";
  size?: number;
  updatedAtMs?: number;
}

export interface WorkspaceFilePreview {
  path: string;
  name: string;
  size: number;
  updatedAtMs?: number;
  mimeType?: string;
  encoding: "utf8" | "base64";
  content: string;
}

export type WorkspaceListingState = "loading" | "ready" | "error" | "offline" | "auth";

export interface SaveFileInput {
  path: string;
  contentBase64?: string;
  contentText?: string;
  overwrite: boolean;
}

export type SaveFileResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: string; code?: string };

function parseEntry(raw: unknown): WorkspaceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.path !== "string" || typeof e.name !== "string") return null;
  const kind = e.kind === "directory" ? "directory" : e.kind === "file" ? "file" : null;
  if (!kind) return null;
  return {
    path: e.path,
    name: e.name,
    kind,
    ...(typeof e.size === "number" ? { size: e.size } : {}),
    ...(typeof e.updatedAtMs === "number" ? { updatedAtMs: e.updatedAtMs } : {}),
  };
}

export function useWorkspace(token: string | null) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [listingState, setListingState] = useState<WorkspaceListingState>("loading");
  const [listingError, setListingError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const listingAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  // Compteur de rafraîchissement : incrémenté par refresh() pour relancer
  // l'effet de listing sans dupliquer la logique de fetch.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listingAbort.current?.abort();
    listingAbort.current = controller;
    setListingState("loading");
    setListingError(null);

    (async () => {
      try {
        const query = path ? `?path=${encodeURIComponent(path)}` : "";
        const res = await fetch(`/api/workspace${query}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.status === 401) {
          setListingState("auth");
          return;
        }
        if (res.status === 503) {
          setListingState("offline");
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setListingError(body?.error ?? `erreur HTTP ${res.status}`);
          setListingState("error");
          return;
        }
        const body = (await res.json()) as { entries?: unknown[] };
        if (controller.signal.aborted) return;
        const parsed = (Array.isArray(body.entries) ? body.entries : [])
          .map(parseEntry)
          .filter((e): e is WorkspaceEntry => e !== null)
          // Dossiers d'abord, puis alphabétique — lecture stable.
          .sort((a, b) =>
            a.kind !== b.kind
              ? a.kind === "directory" ? -1 : 1
              : a.name.localeCompare(b.name, "fr"),
          );
        setEntries(parsed);
        setListingState("ready");
      } catch {
        if (!controller.signal.aborted) {
          setListingError("réseau indisponible");
          setListingState("error");
        }
      }
    })();

    return () => controller.abort();
  }, [token, path, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const navigateTo = useCallback((nextPath: string) => {
    setPreview(null);
    setPreviewState("idle");
    setPath(nextPath);
  }, []);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!token) return;
      const controller = new AbortController();
      previewAbort.current?.abort();
      previewAbort.current = controller;
      setPreviewState("loading");
      setPreviewError(null);
      try {
        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setPreviewError(body?.error ?? `erreur HTTP ${res.status}`);
          setPreviewState("error");
          return;
        }
        const body = (await res.json()) as { file?: Record<string, unknown> };
        const f = body.file;
        if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
          setPreviewError("réponse inattendue");
          setPreviewState("error");
          return;
        }
        setPreview({
          path: f.path,
          name: typeof f.name === "string" ? f.name : f.path,
          size: typeof f.size === "number" ? f.size : 0,
          ...(typeof f.updatedAtMs === "number" ? { updatedAtMs: f.updatedAtMs } : {}),
          ...(typeof f.mimeType === "string" ? { mimeType: f.mimeType } : {}),
          encoding: f.encoding === "base64" ? "base64" : "utf8",
          content: f.content,
        });
        setPreviewState("idle");
      } catch {
        if (!controller.signal.aborted) {
          setPreviewError("réseau indisponible");
          setPreviewState("error");
        }
      }
    },
    [token],
  );

  const closePreview = useCallback(() => {
    previewAbort.current?.abort();
    setPreview(null);
    setPreviewState("idle");
    setPreviewError(null);
  }, []);

  // Envoi d'un fichier : l'appelant gère son propre état pending/succès/échec
  // (pattern accusé UI_UX §5) ; le listing est rafraîchi en cas de succès.
  const saveFile = useCallback(
    async (input: SaveFileInput): Promise<SaveFileResult> => {
      if (!token) return { ok: false, error: "authentification requise" };
      try {
        const res = await fetch("/api/workspace/files", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = (await res.json().catch(() => null)) as
          | { created?: boolean; path?: string; bytes?: number; error?: string; code?: string }
          | null;
        if (res.ok && body?.created && typeof body.path === "string") {
          refresh();
          return { ok: true, path: body.path, bytes: body.bytes ?? 0 };
        }
        return {
          ok: false,
          error: body?.error ?? `erreur HTTP ${res.status}`,
          ...(body?.code ? { code: body.code } : {}),
        };
      } catch {
        return { ok: false, error: "réseau indisponible" };
      }
    },
    [token, refresh],
  );

  return {
    path,
    entries,
    listingState,
    listingError,
    preview,
    previewState,
    previewError,
    navigateTo,
    openFile,
    closePreview,
    refresh,
    saveFile,
  };
}

export type WorkspaceController = ReturnType<typeof useWorkspace>;
