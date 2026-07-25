// src/log.ts — journal du backend : une ligne par événement, horodatée et
// préfixée par le scope déjà employé ailleurs dans src/ (`[gateway]`,
// `[status]`, `[chat]`…) pour que le format reste celui que l'exploitant lit
// déjà dans stdout.log / stderr.log (voir scripts/install-launchd.sh).
//
// Deux règles dictent la forme retenue :
//   - on journalise des ÉVÉNEMENTS (démarrage, arrêt, bascule d'une
//     connexion), pas un flux d'activité : une sonde qui échoue toutes les
//     15 s ou une reconnexion en boucle ne doivent produire qu'une ligne, le
//     jour où l'état change (voir createStateLogger) ;
//   - aucun secret ne sort d'ici : les valeurs passent par `fields`, et une
//     clé qui ressemble à un secret est masquée avant impression. Le garde est
//     mécanique parce que la vigilance de l'appelant, elle, ne se teste pas.

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogSink = (
  level: LogLevel,
  scope: string,
  message: string,
  fields?: LogFields,
) => void;

// Clés dont la valeur ne doit jamais atteindre un fichier de log : AUTH_TOKEN
// du dashboard comme GATEWAY_AUTH_TOKEN de la gateway transitent sous ces noms.
const SECRET_KEY_PATTERN = /token|secret|password|authorization/i;

function formatValue(value: string | number | boolean): string {
  const text = String(value);
  // Une valeur contenant un espace ou un guillemet casserait la relecture en
  // paires clé=valeur (grep, awk) : on la cite alors comme du JSON.
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

// Pure et donc testable (voir log.test.ts) : l'horodatage est injectable.
export function formatLogLine(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: LogFields,
  at: Date = new Date(),
): string {
  let line = `${at.toISOString()} ${level.padEnd(5)} [${scope}] ${message}`;
  for (const [key, value] of Object.entries(fields ?? {})) {
    // Un champ absent est un champ tu : « raison= » ne renseigne personne.
    if (value === undefined || value === null) continue;
    line += ` ${key}=${SECRET_KEY_PATTERN.test(key) ? "***" : formatValue(value)}`;
  }
  return line;
}

// info sur stdout, warn/error sur stderr : launchd écrit les deux flux dans
// des fichiers distincts, et un exploitant qui ouvre stderr.log doit n'y
// trouver que ce qui mérite son attention.
export const log: LogSink = (level, scope, message, fields) => {
  const line = formatLogLine(level, scope, message, fields);
  if (level === "info") console.log(line);
  else console.error(line);
};

export const logInfo = (scope: string, message: string, fields?: LogFields) =>
  log("info", scope, message, fields);
export const logWarn = (scope: string, message: string, fields?: LogFields) =>
  log("warn", scope, message, fields);
export const logError = (scope: string, message: string, fields?: LogFields) =>
  log("error", scope, message, fields);

export interface StateLoggerOptions {
  scope: string;
  // Libellés des deux transitions, en français et sous forme de constat
  // (docs/UI_UX.md §8) : « connexion établie », « sonde en échec ».
  ok: string;
  failed: string;
  // true quand l'état nominal est « ça marche » et ne mérite donc aucune ligne
  // au démarrage (sondes périodiques) ; false quand le premier succès est
  // lui-même l'événement attendu (connexion à la gateway).
  initialOk?: boolean;
  sink?: LogSink;
}

// Journal d'un état binaire qui n'écrit que sur CHANGEMENT. Les sources
// répètent leur état à chaque cycle — reconnexion gateway jusqu'à toutes les
// 30 s, sondes toutes les 5 à 15 s — et une répétition à l'identique n'apprend
// rien à l'exploitant tout en noyant le reste. Un échec dont la RAISON change
// reste journalisé : « authentification refusée » puis « socket fermé » sont
// deux diagnostics différents, pas la même panne.
export function createStateLogger(options: StateLoggerOptions) {
  const { scope, ok, failed, initialOk = false, sink = log } = options;
  let previous: { ok: boolean; reason?: string } | null = initialOk ? { ok: true } : null;

  return {
    ok(): void {
      if (previous?.ok) return;
      previous = { ok: true };
      sink("info", scope, ok);
    },
    failed(reason?: string): void {
      if (previous && !previous.ok && previous.reason === reason) return;
      previous = { ok: false, reason };
      sink("warn", scope, failed, { raison: reason });
    },
  };
}
