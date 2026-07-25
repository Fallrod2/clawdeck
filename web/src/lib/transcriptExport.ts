// src/lib/transcriptExport.ts — export Markdown de la conversation affichée.
//
// Pourquoi un fichier et non le presse-papiers : le dashboard est servi en
// http:// sur une IP Tailscale, `navigator.clipboard` y est absent (voir
// lib/clipboard.ts) et un transcript entier passe mal par la retombée
// `execCommand`. Un téléchargement, lui, fonctionne sans contexte sécurisé.
//
// Portée assumée : seuls les messages CHARGÉS sont exportés — au plus 500,
// sans l'historique complet d'OpenClaw. Le document le dit en tête, sans quoi
// un fichier daté passerait pour une archive exhaustive.

import type { ChatMessage } from "./chatTypes";

function horodatageFichier(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function exportFileName(now: number): string {
  return `clawdeck-conversation-${horodatageFichier(now)}.md`;
}

function jourLisible(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function heure(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function memeJour(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * Rend la conversation en Markdown. `now` est un paramètre pour rester
 * testable — la date d'export figure dans l'en-tête du document.
 */
export function buildTranscriptMarkdown(messages: ChatMessage[], now: number): string {
  const lignes: string[] = [
    "# Conversation clawdeck",
    "",
    `Exportée le ${jourLisible(now)} à ${heure(now)}.`,
  ];

  if (messages.length === 0) {
    lignes.push("", "_Aucun message chargé au moment de l'export._", "");
    return lignes.join("\n");
  }

  // Mention systématique du périmètre : un fichier daté et bien mis en forme
  // serait autrement pris pour l'historique complet.
  lignes.push(
    "",
    `${messages.length} message${messages.length > 1 ? "s" : ""} — uniquement ceux chargés dans` +
      " l'interface, pas l'historique complet d'OpenClaw.",
    "",
  );

  let jourCourant: number | null = null;
  for (const message of messages) {
    if (jourCourant === null || !memeJour(jourCourant, message.timestamp)) {
      jourCourant = message.timestamp;
      lignes.push("", `## ${jourLisible(message.timestamp)}`, "");
    }

    const auteur = message.role === "user" ? "Vous" : "OpenClaw";
    const provenance = message.origin ? ` · via ${message.origin.channel}` : "";
    lignes.push(`### ${auteur} — ${heure(message.timestamp)}${provenance}`, "");

    if (message.reasoning) {
      lignes.push("<details><summary>Raisonnement</summary>", "", message.reasoning, "", "</details>", "");
    }
    lignes.push(message.text, "");

    for (const media of message.media ?? []) {
      // Le chemin, pas le contenu : le fichier reste dans le workspace de
      // l'agent, un export Markdown n'a pas à l'embarquer.
      lignes.push(`_Média joint : \`${media.path}\`_`, "");
    }

    for (const tool of message.toolCalls) {
      const etat = tool.phase === "result" ? (tool.isError ? "erreur" : "terminé") : "en cours";
      const duree = tool.durationMs !== undefined ? `, ${tool.durationMs} ms` : "";
      const sortie = tool.exitCode !== undefined ? `, sortie ${tool.exitCode}` : "";
      lignes.push(`- Outil \`${tool.title ?? tool.name}\` (${etat}${duree}${sortie})`);
    }
    if (message.toolCalls.length > 0) lignes.push("");

    if (message.error) lignes.push(`> Erreur : ${message.error}`, "");
  }

  return `${lignes.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/**
 * Déclenche le téléchargement du transcript. Le blob est révoqué juste après :
 * le laisser vivre retiendrait tout le document en mémoire pour la durée de la
 * page.
 */
export function downloadTranscript(messages: ChatMessage[], now: number = Date.now()): void {
  const contenu = buildTranscriptMarkdown(messages, now);
  const blob = new Blob([contenu], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const lien = document.createElement("a");
  lien.href = url;
  lien.download = exportFileName(now);
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  URL.revokeObjectURL(url);
}
