import { expect, test } from "bun:test";
import { normalizeLogTail } from "./logs";

test("normalizeLogTail keeps only bounded operational fields", () => {
  const entries = normalizeLogTail({
    cursor: 42,
    size: 42,
    truncated: false,
    reset: false,
    lines: [JSON.stringify({
      0: JSON.stringify({ subsystem: "whatsapp" }),
      1: "provider connected",
      _meta: { logLevelName: "WARN", name: JSON.stringify({ subsystem: "whatsapp" }) },
      time: "2026-07-10T14:00:00+02:00",
      secretExtraField: "must-not-leak",
    })],
  });

  expect(entries).toEqual([{
    id: "42-0",
    timestamp: "2026-07-10T14:00:00+02:00",
    level: "warn",
    subsystem: "whatsapp",
    message: "provider connected",
  }]);
  expect(JSON.stringify(entries)).not.toContain("must-not-leak");
});
