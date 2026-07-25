import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HISTORY_HOURS,
  isValidBase64,
  MAX_HISTORY_HOURS,
  parseHours,
  safeTokenEqual,
} from "./validate";

describe("isValidBase64", () => {
  test("accepte du base64 canonique, bourrage compris", () => {
    expect(isValidBase64(Buffer.from("bonjour").toString("base64"))).toBe(true);
    expect(isValidBase64("QQ==")).toBe(true);
    expect(isValidBase64("QUJD")).toBe(true);
    expect(isValidBase64("QUJDRA==")).toBe(true);
    // Contenu vide = fichier vide, pas une erreur de format.
    expect(isValidBase64("")).toBe(true);
  });

  test("refuse ce que Buffer.from aurait avalé en silence", () => {
    // Le cas qui écrivait un fichier corrompu avec un 200 : Buffer.from rend
    // des octets au lieu de signaler une erreur.
    expect(Buffer.from("!!!pas du base64!!!", "base64").length).toBeGreaterThan(0);
    expect(isValidBase64("!!!pas du base64!!!")).toBe(false);
    expect(isValidBase64("abc")).toBe(false); // longueur non multiple de 4
    expect(isValidBase64("ab=c")).toBe(false); // bourrage au milieu
    expect(isValidBase64("QQ===")).toBe(false); // bourrage excessif
    expect(isValidBase64("QU JD")).toBe(false); // espace interne
  });
});

test("safeTokenEqual n'accepte que le token exact", () => {
  expect(safeTokenEqual("secret-token", "secret-token")).toBe(true);
  expect(safeTokenEqual("secret-tokeX", "secret-token")).toBe(false);
  expect(safeTokenEqual("secret", "secret-token")).toBe(false);
  expect(safeTokenEqual("", "secret-token")).toBe(false);
  expect(safeTokenEqual(null, "secret-token")).toBe(false);
  expect(safeTokenEqual(42, "secret-token")).toBe(false);
  expect(safeTokenEqual("secret-token", "")).toBe(false);
});

test("parseHours borne les valeurs valides et garde le défaut", () => {
  expect(parseHours(undefined)).toBe(DEFAULT_HISTORY_HOURS);
  expect(parseHours("")).toBe(DEFAULT_HISTORY_HOURS);
  expect(parseHours("24")).toBe(24);
  expect(parseHours("0.5")).toBe(1);
  expect(parseHours("0")).toBe(1);
  expect(parseHours("-5")).toBe(1);
  expect(parseHours("9999")).toBe(MAX_HISTORY_HOURS);
});

test("parseHours rejette les valeurs non finies par null", () => {
  expect(parseHours("abc")).toBe(null);
  expect(parseHours("NaN")).toBe(null);
  expect(parseHours("Infinity")).toBe(null);
  expect(parseHours("-Infinity")).toBe(null);
});
