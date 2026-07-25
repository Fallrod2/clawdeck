// Frames hostiles ou simplement malformées reçues de la gateway.
//
// Enjeu réel, pas théorique : une exception levée dans `ws.onmessage`
// TERMINE le processus Bun. Ce chemin est PRÉ-AUTHENTIFICATION et l'émetteur
// est ce qui occupe le port désigné par GATEWAY_URL — une variable mal
// réglée, un autre service, une gateway boguée. Une seule frame inattendue
// suffisait donc à tuer le dashboard, qui restait mort jusqu'à relance
// manuelle.
//
// Ces tests utilisent un VRAI serveur WebSocket Bun : le socket factice des
// autres tests appelle `onmessage` directement, donc dans le contexte du
// test, ce qui masquerait précisément le comportement qu'on veut éprouver.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "./client";

const identityDir = mkdtempSync(join(tmpdir(), "clawdeck-frames-hostiles-"));
afterAll(() => rmSync(identityDir, { recursive: true, force: true }));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition non atteinte avant expiration");
    await Bun.sleep(10);
  }
}

/**
 * Démarre une gateway factice qui envoie les charges fournies dès la
 * connexion, puis se tait. Renvoie de quoi l'arrêter.
 */
function fausseGateway(charges: string[]) {
  let connexions = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("websocket attendu", { status: 426 });
    },
    websocket: {
      open(ws) {
        connexions += 1;
        for (const charge of charges) ws.send(charge);
      },
      message() {},
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    get connexions() {
      return connexions;
    },
    stop: () => server.stop(true),
  };
}

async function survitA(charges: string[]): Promise<boolean> {
  const gateway = fausseGateway(charges);
  const client = new GatewayClient(gateway.url, "jeton", join(identityDir, `${Math.random()}.json`), {
    handshakeTimeoutMs: 60_000,
  });
  try {
    client.start();
    await waitFor(() => gateway.connexions >= 1);
    // Laisse le temps aux frames d'être traitées ; si le processus devait
    // mourir, il mourrait ici.
    await Bun.sleep(150);
    // Le client doit être encore utilisable : ni connecté (le handshake n'a
    // pas eu lieu) ni cassé.
    return client.isConnected === false;
  } finally {
    client.stop();
    gateway.stop();
  }
}

describe("frames malformées reçues de la gateway", () => {
  test("une frame `null` n'interrompt rien", async () => {
    // `JSON.parse("null")` ne lève PAS : c'est le déréférencement qui tuait.
    expect(await survitA(["null"])).toBe(true);
  });

  test("un scalaire ou un tableau à la place d'un objet", async () => {
    expect(await survitA(["42", '"texte"', "[1,2,3]", "true"])).toBe(true);
  });

  test("un défi de connexion amputé de sa charge utile", async () => {
    // Le cas le plus vicieux : la frame a la bonne forme jusqu'au moment où
    // l'on déréférence `payload.nonce`.
    expect(await survitA(['{"type":"event","event":"connect.challenge"}'])).toBe(true);
  });

  test("un défi dont le nonce n'est pas une chaîne", async () => {
    expect(
      await survitA([
        '{"type":"event","event":"connect.challenge","payload":{"nonce":null}}',
        '{"type":"event","event":"connect.challenge","payload":{"nonce":{"a":1}}}',
        '{"type":"event","event":"connect.challenge","payload":{}}',
      ]),
    ).toBe(true);
  });

  test("une rafale hétéroclite, telle qu'un service étranger pourrait en produire", async () => {
    expect(
      await survitA([
        "null",
        "{}",
        '{"type":null}',
        '{"type":"res"}',
        '{"type":"res","id":"connect"}',
        '{"type":"event"}',
        '{"type":"event","event":"sessions.changed"}',
        '{"type":"event","event":"chat"}',
        "pas du json du tout",
        '{"type":"event","event":"connect.challenge","payload":null}',
      ]),
    ).toBe(true);
  });

  test("un hello-ok sans charge utile ne fait pas passer pour connecté", async () => {
    const gateway = fausseGateway(['{"type":"res","id":"connect","ok":true}']);
    const client = new GatewayClient(gateway.url, "jeton", join(identityDir, "hello-vide.json"), {
      handshakeTimeoutMs: 60_000,
    });
    try {
      client.start();
      await waitFor(() => gateway.connexions >= 1);
      await Bun.sleep(150);
      // Protocole absent : la négociation doit échouer, pas être supposée.
      expect(client.isConnected).toBe(false);
      expect(client.negotiatedProtocol).toBe(null);
    } finally {
      client.stop();
      gateway.stop();
    }
  });
});
