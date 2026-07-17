// src/gateway/client.test.ts — watchdog de handshake du GatewayClient, via
// une factory de sockets factices (aucun réseau réel, vrais timers courts).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "./client";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await Bun.sleep(5);
  }
}

// Socket factice minimal : muet par défaut (n'envoie jamais connect.challenge),
// piloté à la main par les tests via receive()/onclose.
class FakeSocket {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    // Comme un vrai socket, la fermeture déclenche onclose de façon asynchrone.
    queueMicrotask(() => this.onclose?.(new CloseEvent("close")));
  }

  receive(frame: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

const identityDir = mkdtempSync(join(tmpdir(), "clawdeck-test-identity-"));
afterAll(() => rmSync(identityDir, { recursive: true, force: true }));

function createClient(handshakeTimeoutMs: number) {
  const sockets: FakeSocket[] = [];
  const client = new GatewayClient(
    "ws://gateway.test",
    "token-test",
    join(identityDir, "identity.json"),
    {
      handshakeTimeoutMs,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
  );
  return { client, sockets };
}

describe("GatewayClient — watchdog de handshake", () => {
  test("ferme un socket resté muet puis relance une connexion", async () => {
    const { client, sockets } = createClient(25);
    client.start();

    expect(sockets.length).toBe(1);
    const first = sockets[0]!;
    expect(first.closeCalls).toBe(0);

    // Aucun connect.challenge n'arrive : le watchdog ferme le socket…
    await waitFor(() => first.closeCalls >= 1);
    expect(client.isConnected).toBe(false);

    // …et le chemin normal onclose → reconnexion ouvre un nouveau socket.
    await waitFor(() => sockets.length >= 2, 2_000);

    client.stop();
  });

  test("ne ferme rien une fois la connexion aboutie", async () => {
    const { client, sockets } = createClient(25);
    client.start();
    const socket = sockets[0]!;

    // Handshake complet : challenge de la gateway puis connect-ok.
    socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-test" } });
    expect(socket.sent.length).toBe(1);
    socket.receive({ type: "res", id: "connect", ok: true, payload: {} });
    expect(client.isConnected).toBe(true);

    // Bien après l'échéance du watchdog, le socket n'a jamais été fermé.
    await Bun.sleep(80);
    expect(socket.closeCalls).toBe(0);
    expect(client.isConnected).toBe(true);
    expect(sockets.length).toBe(1);

    client.stop();
  });
});
