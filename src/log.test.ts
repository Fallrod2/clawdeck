import { expect, test } from "bun:test";
import { createStateLogger, formatLogLine, type LogFields, type LogLevel } from "./log";

const AT = new Date("2026-07-25T14:30:05.120Z");

test("formatLogLine produit une ligne horodatée, niveau et scope en tête", () => {
  expect(formatLogLine("info", "http", "backend démarré", undefined, AT)).toBe(
    "2026-07-25T14:30:05.120Z info  [http] backend démarré",
  );
  expect(formatLogLine("error", "arret", "fermeture de la base", undefined, AT)).toBe(
    "2026-07-25T14:30:05.120Z error [arret] fermeture de la base",
  );
});

test("formatLogLine ajoute les champs en clé=valeur et cite ce qui contient un espace", () => {
  const line = formatLogLine(
    "info",
    "http",
    "backend démarré",
    { adresse: "http://127.0.0.1:3001", tentative: 2, forcé: true },
    AT,
  );
  expect(line).toBe(
    '2026-07-25T14:30:05.120Z info  [http] backend démarré adresse=http://127.0.0.1:3001 tentative=2 forcé=true',
  );
  expect(formatLogLine("warn", "gateway", "connexion indisponible", { raison: "socket fermé" }, AT)).toBe(
    '2026-07-25T14:30:05.120Z warn  [gateway] connexion indisponible raison="socket fermé"',
  );
});

test("formatLogLine tait les champs absents plutôt que d'écrire une valeur vide", () => {
  const line = formatLogLine("warn", "gateway", "connexion indisponible", {
    raison: undefined,
    detail: null,
  }, AT);
  expect(line).toBe("2026-07-25T14:30:05.120Z warn  [gateway] connexion indisponible");
});

test("formatLogLine masque toute valeur dont la clé ressemble à un secret", () => {
  const line = formatLogLine("error", "gateway", "auth refusée", {
    token: "s3cr3t-token-value",
    gatewayAuthToken: "autre-secret",
    Authorization: "Bearer s3cr3t",
    motDePasse: "x",
    hote: "127.0.0.1",
  }, AT);
  expect(line).toContain("token=***");
  expect(line).toContain("gatewayAuthToken=***");
  expect(line).toContain("Authorization=***");
  expect(line).toContain("hote=127.0.0.1");
  expect(line).not.toContain("s3cr3t");
  expect(line).not.toContain("autre-secret");
});

// Sink de test : capture ce qui serait écrit, sans toucher à la console.
function recorder() {
  const lines: string[] = [];
  const sink = (level: LogLevel, scope: string, message: string, fields?: LogFields) => {
    lines.push(formatLogLine(level, scope, message, fields, AT));
  };
  return { lines, sink };
}

test("createStateLogger n'écrit que les bascules, pas chaque cycle", () => {
  const { lines, sink } = recorder();
  const state = createStateLogger({
    scope: "gateway",
    ok: "connexion établie",
    failed: "connexion indisponible",
    sink,
  });

  state.ok();
  state.ok();
  state.ok();
  state.failed("socket fermé");
  state.failed("socket fermé");
  state.failed("socket fermé");
  state.ok();

  expect(lines).toEqual([
    "2026-07-25T14:30:05.120Z info  [gateway] connexion établie",
    '2026-07-25T14:30:05.120Z warn  [gateway] connexion indisponible raison="socket fermé"',
    "2026-07-25T14:30:05.120Z info  [gateway] connexion établie",
  ]);
});

test("createStateLogger réécrit quand la raison de l'échec change", () => {
  const { lines, sink } = recorder();
  const state = createStateLogger({
    scope: "gateway",
    ok: "connexion établie",
    failed: "connexion indisponible",
    sink,
  });

  state.failed("authentification refusée");
  state.failed("authentification refusée");
  state.failed("socket fermé");

  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('raison="socket fermé"');
});

test("createStateLogger initialOk reste muet tant que la sonde va bien", () => {
  const { lines, sink } = recorder();
  const probe = createStateLogger({
    scope: "openclaw",
    ok: "sonde rétablie",
    failed: "sonde en échec",
    initialOk: true,
    sink,
  });

  probe.ok();
  probe.ok();
  expect(lines).toEqual([]);

  probe.failed("gateway déconnectée");
  probe.ok();
  expect(lines).toEqual([
    '2026-07-25T14:30:05.120Z warn  [openclaw] sonde en échec raison="gateway déconnectée"',
    "2026-07-25T14:30:05.120Z info  [openclaw] sonde rétablie",
  ]);
});
