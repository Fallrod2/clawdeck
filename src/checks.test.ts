import { expect, test } from "bun:test";
import { isOllamaModelReady } from "./checks";

test("Ollama fallback readiness requires the configured tag", () => {
  expect(isOllamaModelReady(["qwen3.5:9b"], "qwen3.5:9b")).toBe(true);
  expect(isOllamaModelReady(["qwen3.5:2b"], "qwen3.5:9b")).toBe(false);
  expect(isOllamaModelReady(["qwen3.5:latest"], "qwen3.5:9b")).toBe(false);
});
