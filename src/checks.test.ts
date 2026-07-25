import { describe, expect, test } from "bun:test";
import { checkGateway, checkOllama, isOllamaModelReady } from "./checks";

test("Ollama fallback readiness requires the configured tag", () => {
  expect(isOllamaModelReady(["qwen3.5:9b"], "qwen3.5:9b")).toBe(true);
  expect(isOllamaModelReady(["qwen3.5:2b"], "qwen3.5:9b")).toBe(false);
  expect(isOllamaModelReady(["qwen3.5:latest"], "qwen3.5:9b")).toBe(false);
});

describe("causes d'échec destinées à l'opérateur", () => {
  // Le défaut corrigé : les messages d'exception bruts recopiaient du code
  // source dans l'interface (« ((await res.json()).models ?? []).map is not a
  // function »). Une console d'exploitation dit ce qui ne va pas, elle ne
  // montre pas ses entrailles.
  const codeSource = /=>|\{|\}|\(\)|is not a function|undefined is not/;

  test("un port fermé donne une cause lisible, pas une trace", async () => {
    const port = await portLibre();
    const r = await checkGateway(`http://127.0.0.1:${port}`, 500);
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error!).not.toMatch(codeSource);
  });

  test("un corps illisible d'Ollama aussi", async () => {
    const serveur = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pas du json") });
    try {
      const r = await checkOllama(`http://127.0.0.1:${serveur.port}`, "qwen3.5:9b", 500);
      expect(r.ok).toBe(false);
      expect(r.error!).not.toMatch(codeSource);
      // La latence a bien été mesurée : c'est elle qui distingue
      // « injoignable » de « répond mal ».
      expect(r.latencyMs).not.toBeNull();
    } finally {
      serveur.stop(true);
    }
  });

  test("un statut HTTP en échec de la gateway dit LEQUEL", async () => {
    const serveur = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("non", { status: 503 }) });
    try {
      const r = await checkGateway(`http://127.0.0.1:${serveur.port}`, 500);
      expect(r.ok).toBe(false);
      // Sans cause, la carte affiche une pastille rouge muette.
      expect(r.error).toBe("HTTP 503");
      expect(r.latencyMs).not.toBeNull();
    } finally {
      serveur.stop(true);
    }
  });

  test("la liste de modèles tient son contrat `string[]`", async () => {
    const serveur = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ models: [{}, { name: 123 }, { name: "qwen3.5:9b" }, null] }),
    });
    try {
      const r = await checkOllama(`http://127.0.0.1:${serveur.port}`, "qwen3.5:9b", 500);
      expect(r.models).toEqual(["qwen3.5:9b"]);
      expect(r.fallbackModelReady).toBe(true);
    } finally {
      serveur.stop(true);
    }
  });
});

// Réserve puis libère un port : le rebind immédiat qui suit tombe donc sur un
// port dont on sait qu il était libre à l instant.
async function portLibre(): Promise<number> {
  const serveur = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = serveur.port ?? 0;
  serveur.stop(true);
  return port;
}
