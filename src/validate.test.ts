import { expect, test } from "bun:test";
import {
  DEFAULT_HISTORY_HOURS,
  MAX_HISTORY_HOURS,
  parseHours,
  safeTokenEqual,
} from "./validate";

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
