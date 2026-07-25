// src/gateway-degradee.test.ts — le chemin de collecte RÉEL (GatewayClient →
// readOpenClawRuntime, GatewayClient → LogTailer, tel que le câble index.ts)
// face à une gateway présente mais qui répond MAL : charabia, refus, réponse
// arrivée trop tard, frames illisibles.
//
// L'absence de gateway est déjà couverte (client.test.ts, status-collector).
// Ce qui manquait : ce que produisent les collecteurs quand la dépendance est
// là, parle, et raconte n'importe quoi. Les RPC passent par la vraie machine à
// états du client — socket factice via la factory injectable, aucun réseau.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "./gateway/client";
import { LogTailer, type LogTailEvent } from "./log-tailer";
import { readOpenClawRuntime } from "./openclaw-status";
import { createOpenClawUsageReader } from "./openclaw-usage";

async function attendre(predicat: () => boolean, delaiMs = 500): Promise<void> {
  const echeance = Date.now() + delaiMs;
  while (!predicat()) {
    if (Date.now() >= echeance) throw new Error("condition jamais atteinte");
    await Bun.sleep(5);
  }
}

// Socket factice muet : il n'envoie que ce qu'un test lui dicte. `receiveBrut`
// existe pour livrer des octets qui ne sont pas du JSON — ce qu'un socket
// sérialisant à notre place ne permettrait pas d'éprouver.
class FauxSocket {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly envoyees: string[] = [];
  readonly repondues = new Set<string>();
  fermetures = 0;

  send(data: string): void {
    this.envoyees.push(data);
  }

  close(): void {
    this.fermetures += 1;
    queueMicrotask(() => this.onclose?.(new CloseEvent("close")));
  }

  receive(frame: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  receiveBrut(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  frames(): Array<Record<string, any>> {
    return this.envoyees.map((brut) => JSON.parse(brut));
  }

  requetes(methode?: string): Array<Record<string, any>> {
    return this.frames().filter(
      (f) => f.type === "req" && f.id !== "connect" && (!methode || f.method === methode),
    );
  }
}

const dossierIdentite = mkdtempSync(join(tmpdir(), "clawdeck-degrade-"));
afterAll(() => rmSync(dossierIdentite, { recursive: true, force: true }));

// Toutes les méthodes que les collecteurs consomment : la découverte doit les
// annoncer, sinon le client court-circuite les appels et le test n'éprouverait
// plus qu'un refus local.
const METHODES = [
  "health",
  "sessions.list",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "channels.status",
  "models.list",
  "agents.list",
  "agents.workspace.list",
  "logs.tail",
  "usage.status",
  "usage.cost",
  "chat.send",
];

function creerClient(options: { requestTimeoutMs?: number; tickIntervalFallbackMs?: number } = {}) {
  const sockets: FauxSocket[] = [];
  const client = new GatewayClient(
    "ws://gateway.test",
    "token-test",
    join(dossierIdentite, "identity.json"),
    {
      handshakeTimeoutMs: 5_000,
      ...options,
      socketFactory: () => {
        const socket = new FauxSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
  );
  return { client, sockets };
}

function helloOk(overrides: { tickIntervalMs?: number } = {}) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.7.1", connId: "conn-test" },
    features: { methods: METHODES, events: ["tick", "chat", "agent", "session.message"] },
    snapshot: { uptimeMs: 12_345, sessionDefaults: { mainSessionKey: "main" } },
    auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
    policy: {
      maxPayload: 1_000_000,
      tickIntervalMs: overrides.tickIntervalMs ?? 60_000,
    },
  };
}

function handshake(socket: FauxSocket, hello: Record<string, unknown> = helloOk()) {
  socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-test" } });
  socket.receive({ type: "res", id: "connect", ok: true, payload: hello });
}

// Répond à toutes les requêtes encore en attente, le répondeur décidant par
// méthode. Les collecteurs tirent leurs RPC en parallèle : répondre frame par
// frame dans un ordre imposé cacherait ce parallélisme.
function repondreATout(
  socket: FauxSocket,
  repondeur: (methode: string) => { ok: boolean; payload?: unknown; error?: unknown },
): void {
  for (const frame of socket.requetes()) {
    if (socket.repondues.has(frame.id)) continue;
    socket.repondues.add(frame.id);
    socket.receive({ type: "res", id: frame.id, ...repondeur(frame.method) });
  }
}

// Le client part de lui-même en quête de sa session dès la connexion. Solder
// ces requêtes évite qu'elles traînent dans la file d'attente : un test sur
// l'aiguillage des réponses doit observer une file où il est seul à écrire,
// sinon une réponse mal aiguillée irait se perdre dans une requête de mise en
// place et passerait inaperçue.
async function soldeLaMiseEnPlaceDeSession(socket: FauxSocket): Promise<void> {
  await attendre(() => socket.requetes("sessions.list").length > 0);
  repondreATout(socket, () => ({ ok: true, payload: { sessions: [{ key: "main" }] } }));
  await attendre(() => socket.requetes("sessions.messages.subscribe").length > 0);
  repondreATout(socket, () => ({ ok: true, payload: {} }));
}

// Lecteur neuf par cas : l'étranglement du lecteur par défaut ferait fuir
// l'usage lu par un test dans le suivant.
const lecteurUsage = () => createOpenClawUsageReader({ minIntervalMs: 0 });

describe("collecte d'état face à une gateway qui ment", () => {
  test("charabia sur tous les RPC : un instantané complet, aucune valeur inventée", async () => {
    // Le pire cas d'un schéma inattendu n'est pas l'exception — elle ferait
    // tomber le cycle et se verrait — mais la valeur plausible tirée d'un
    // champ mal typé : un provider, un modèle ou un quota affichés comme des
    // faits alors que rien ne les soutient.
    const { client, sockets } = creerClient();
    client.start();
    const socket = sockets[0]!;
    handshake(socket);

    const charabia: Record<string, unknown> = {
      health: "ok",
      "sessions.list": { sessions: "beaucoup" },
      "channels.status": [1, 2, 3],
      "models.list": { models: { whatsapp: true } },
      "agents.list": { agents: 42 },
      "usage.status": "rien",
      "usage.cost": 12,
    };
    const promesse = readOpenClawRuntime(client, lecteurUsage());
    await attendre(() => socket.requetes("usage.cost").length > 0);
    repondreATout(socket, (methode) => ({ ok: true, payload: charabia[methode] ?? null }));

    const runtime = await promesse;

    expect(runtime.connected).toBe(true);
    // Aucun champ n'est déduit d'un type qui n'est pas le sien.
    expect(runtime.healthy).toBeNull();
    expect(runtime.healthTimestamp).toBeNull();
    expect(runtime.provider).toBeNull();
    expect(runtime.model).toBeNull();
    expect(runtime.configuredModel).toBeNull();
    expect(runtime.usingFallback).toBeNull();
    expect(runtime.modelAvailable).toBeNull();
    expect(Object.values(runtime.whatsapp).every((valeur) => valeur === null)).toBe(true);
    // « Vide » et non « prêt à zéro » : un quota fantôme se lirait comme une
    // consommation nulle, exactement le mensonge que l'usage doit éviter.
    expect(runtime.usage?.quota.state).toBe("empty");
    expect(runtime.usage?.quota.providers).toEqual([]);
    expect(runtime.usage?.cost.state).toBe("empty");
    // Des RPC qui répondent « ok » ne sont pas des RPC en échec : la charge
    // est inexploitable, la gateway n'a pour autant rien refusé.
    expect(runtime.error).toBeUndefined();

    client.stop();
  });

  test("enveloppe crédible mais feuilles mal typées : rien n'est déduit d'un type qui n'est pas le sien", async () => {
    // Cas plus insidieux que le charabia : la forme est la bonne, seuls les
    // types des feuilles mentent. Une normalisation qui convertirait au lieu
    // de vérifier afficherait « modèle [object Object] » ou un canal WhatsApp
    // « sain » déduit d'une chaîne « oui » — des faits inventés, pas des trous.
    const { client, sockets } = creerClient();
    client.start();
    const socket = sockets[0]!;
    handshake(socket);

    const malTypes: Record<string, unknown> = {
      health: { ok: "oui", ts: "maintenant", durationMs: [] },
      "sessions.list": {
        sessions: [{ key: "main", modelProvider: 7, model: { nom: "qwen3.5:9b" } }],
      },
      "channels.status": {
        channels: {
          whatsapp: {
            configured: "oui",
            linked: 1,
            running: "true",
            connected: 0,
            healthState: 12,
            lastInboundAt: "hier",
            lastError: 500,
          },
        },
      },
      // Catalogue bien formé mais sans rapport avec le couple actif : aucune
      // disponibilité ne doit en être tirée.
      "models.list": { models: [{ id: "gpt-5.4", provider: "openai", available: true }] },
      "agents.list": { agents: [{ id: "main", model: { primary: 42 } }] },
      // Pourcentages hors bornes : le contrat 0-100 tient côté dashboard, quoi
      // qu'annonce la gateway — une barre de progression à 250 % ne veut rien
      // dire, et un négatif se lirait comme une marge disponible.
      "usage.status": {
        updatedAt: "hier",
        providers: [{
          provider: "openai",
          windows: [
            { label: "5 h", usedPercent: 250 },
            { label: "Semaine", usedPercent: -30 },
            { label: "Mois", usedPercent: "beaucoup" },
          ],
        }],
      },
      "usage.cost": {
        days: 7,
        totals: { totalTokens: "plein", missingCostEntries: "quelques" },
        cacheStatus: { status: "inventé" },
      },
    };
    const promesse = readOpenClawRuntime(client, lecteurUsage());
    await attendre(() => socket.requetes("usage.cost").length > 0);
    repondreATout(socket, (methode) => ({ ok: true, payload: malTypes[methode] ?? null }));

    const runtime = await promesse;

    expect(runtime.healthy).toBeNull();
    expect(runtime.healthTimestamp).toBeNull();
    expect(runtime.healthDurationMs).toBeNull();
    expect(runtime.provider).toBeNull();
    expect(runtime.model).toBeNull();
    expect(runtime.configuredModel).toBeNull();
    expect(runtime.modelAvailable).toBeNull();
    expect(Object.values(runtime.whatsapp).every((valeur) => valeur === null)).toBe(true);

    const fournisseur = runtime.usage?.quota.providers[0];
    expect(fournisseur?.windows.map((f) => f.usedPercent)).toEqual([100, 0]);
    expect(fournisseur?.worstUsedPercent).toBe(100);
    expect(runtime.usage?.quota.measuredAt).toBeNull();
    // Des totaux illisibles ne valent pas une consommation nulle mesurée.
    expect(runtime.usage?.cost.totalTokens).toBe(0);
    expect(runtime.usage?.cost.freshness).toBeNull();

    client.stop();
  });

  test("RPC tous refusés : connecté n'est pas sain, et la cause n'est dite qu'une fois", async () => {
    const { client, sockets } = creerClient();
    client.start();
    const socket = sockets[0]!;
    handshake(socket);

    const promesse = readOpenClawRuntime(client, lecteurUsage());
    await attendre(() => socket.requetes("usage.cost").length > 0);
    repondreATout(socket, () => ({ ok: false, error: { message: "gateway busy" } }));

    const runtime = await promesse;

    // Trois états à ne jamais confondre : déconnecté (healthy false, voir
    // unavailableOpenClawRuntime), connecté et sain (true), connecté mais
    // incapable de répondre (null). Un `false` ici ferait passer une gateway
    // muette pour une gateway en panne franche.
    expect(runtime.connected).toBe(true);
    expect(runtime.healthy).toBeNull();
    // Cinq RPC refusés à l'identique tiennent en une phrase : la console
    // afficherait sinon cinq fois la même, en couvrant les vraies causes.
    expect(runtime.error).toBe("gateway busy");
    // L'usage porte sa panne dans son propre état sans alourdir `error`.
    expect(runtime.usage?.quota.state).toBe("error");
    expect(runtime.usage?.cost.state).toBe("error");

    client.stop();
  });
});

describe("réponses hors délai et hors connexion", () => {
  test("réponse arrivée après l'échéance : elle ne résout plus rien", async () => {
    // Une gateway qui répond après coup ne doit jamais réveiller une requête
    // déjà abandonnée, ni pire, servir sa charge périmée à la requête
    // SUIVANTE — un tail de logs rejoué ou une route de livraison expirée
    // seraient alors pris pour l'état courant.
    const { client, sockets } = creerClient({ requestTimeoutMs: 30 });
    client.start();
    const socket = sockets[0]!;
    handshake(socket);
    await soldeLaMiseEnPlaceDeSession(socket);

    const premiere = client.getLogs();
    await expect(premiere).rejects.toThrow(/timed out/);
    const idPerime = socket.requetes("logs.tail")[0]!.id;

    let resolue = false;
    const seconde = client.getLogs().then((resultat) => {
      resolue = true;
      return resultat;
    });
    const idCourant = socket.requetes("logs.tail")[1]!.id;
    expect(idCourant).not.toBe(idPerime);

    socket.receive({
      type: "res",
      id: idPerime,
      ok: true,
      payload: { cursor: 999, size: 999, lines: ["ligne périmée"], truncated: false, reset: false },
    });
    await Bun.sleep(10);
    expect(resolue).toBe(false);

    socket.receive({
      type: "res",
      id: idCourant,
      ok: true,
      payload: { cursor: 1, size: 1, lines: ["ligne fraîche"], truncated: false, reset: false },
    });
    expect((await seconde).lines).toEqual(["ligne fraîche"]);

    client.stop();
  });

  test("réponse d'une connexion morte : la requête de la nouvelle n'en veut pas", async () => {
    // Même risque au travers d'une reconnexion, où il serait plus insidieux :
    // il suffirait que le compteur d'identifiants reparte de zéro pour qu'une
    // trame de l'ancienne connexion résolve une requête de la nouvelle.
    const { client, sockets } = creerClient();
    client.start();
    const premierSocket = sockets[0]!;
    handshake(premierSocket);

    const abandonnee = client.getLogs();
    const idAncien = premierSocket.requetes("logs.tail")[0]!.id;
    client.stop();
    // Une requête en vol au moment de la coupure est rejetée sans attendre son
    // échéance — et l'attendre ici, c'est aussi laisser la fermeture être
    // digérée avant de rouvrir, comme dans la vraie boucle de reconnexion.
    await expect(abandonnee).rejects.toThrow(/closed/);

    client.start();
    const secondSocket = sockets[1]!;
    handshake(secondSocket);
    await soldeLaMiseEnPlaceDeSession(secondSocket);

    let resolue = false;
    const courante = client.getLogs().then((resultat) => {
      resolue = true;
      return resultat;
    });
    const idCourant = secondSocket.requetes("logs.tail")[0]!.id;
    expect(idCourant).not.toBe(idAncien);

    secondSocket.receive({
      type: "res",
      id: idAncien,
      ok: true,
      payload: { cursor: 999, size: 999, lines: ["ligne d'avant"], truncated: false, reset: false },
    });
    await Bun.sleep(10);
    expect(resolue).toBe(false);

    secondSocket.receive({
      type: "res",
      id: idCourant,
      ok: true,
      payload: { cursor: 1, size: 1, lines: ["ligne fraîche"], truncated: false, reset: false },
    });
    expect((await courante).lines).toEqual(["ligne fraîche"]);

    client.stop();
  });

  test("frames illisibles : la liaison survit et reste réputée vivante", async () => {
    // Le watchdog de vivacité est réarmé AVANT le parsing, délibérément : une
    // frame illisible prouve que la liaison transporte encore des octets. Si
    // le parsing passait devant, une gateway bavarde mais mal encodée serait
    // fermée toutes les deux échéances et reconnectée en boucle.
    const { client, sockets } = creerClient();
    client.start();
    const socket = sockets[0]!;
    handshake(socket, helloOk({ tickIntervalMs: 30 }));
    expect(client.isConnected).toBe(true);

    // Échéance à 60 ms ; 120 ms de charabia régulier la franchissent deux fois.
    for (let i = 0; i < 12; i++) {
      socket.receiveBrut(i % 2 === 0 ? "pas du json" : '{"type":"res","id":');
      await Bun.sleep(10);
    }

    expect(socket.fermetures).toBe(0);
    expect(client.isConnected).toBe(true);

    client.stop();
  });
});

describe("agent par défaut annoncé de travers", () => {
  test("identifiant d'agent non exploitable : échec franc, jamais une requête au hasard", async () => {
    // Le workspace de l'agent est la racine sous laquelle l'onglet Fichiers
    // lit ET écrit. Un identifiant mal typé accepté ici ferait porter ces
    // opérations sur un agent que personne n'a désigné : mieux vaut refuser.
    const { client, sockets } = creerClient();
    client.start();
    const socket = sockets[0]!;
    handshake(socket);

    for (const payload of [{ agents: [{ id: 123, workspace: "/tmp/x" }] }, { agents: [] }, null]) {
      // L'issue est capturée plutôt qu'assertée tout de suite : `expect(...)
      // .rejects` attend la promesse sur-le-champ, et la réponse de la
      // gateway n'est donnée que quelques lignes plus bas.
      const issue = client.getWorkspaceListing().then(() => null, (erreur: Error) => erreur);
      await attendre(() => socket.requetes("agents.list").some((f) => !socket.repondues.has(f.id)));
      repondreATout(socket, () => ({ ok: true, payload }));

      expect((await issue)?.message).toMatch(/agent par défaut/);
      // Aucune navigation n'a été tentée sans agent résolu.
      expect(socket.requetes("agents.workspace.list")).toHaveLength(0);
    }

    client.stop();
  });

  test("l'agent par défaut est ré-interrogé après une reconnexion", async () => {
    // Le cache d'agent vaut pour UNE connexion : une gateway redémarrée peut
    // exposer un autre agent par défaut, donc une autre racine de workspace.
    // Le resservir écrirait des fichiers sous une racine qui n'est plus celle
    // de l'agent supervisé.
    const { client, sockets } = creerClient();
    client.start();
    const premierSocket = sockets[0]!;
    handshake(premierSocket);

    const premier = client.getDefaultAgent();
    await attendre(() => premierSocket.requetes("agents.list").length > 0);
    repondreATout(premierSocket, () => ({
      ok: true,
      payload: { agents: [{ id: "main", workspace: "/racine/avant" }] },
    }));
    expect(await premier).toEqual({ id: "main", workspace: "/racine/avant" });

    client.stop();
    // La fermeture est digérée avant de rouvrir : dans la vraie boucle, un
    // socket n'est ouvert que depuis onclose, jamais avant lui.
    await Bun.sleep(0);
    client.start();
    const secondSocket = sockets[1]!;
    handshake(secondSocket);

    const second = client.getDefaultAgent();
    await attendre(() => secondSocket.requetes("agents.list").length > 0);
    repondreATout(secondSocket, () => ({
      ok: true,
      payload: { agents: [{ id: "autre", workspace: "/racine/apres" }] },
    }));
    expect(await second).toEqual({ id: "autre", workspace: "/racine/apres" });

    client.stop();
  });
});

describe("tail de logs face à une charge incomplète", () => {
  test("réponse mal formée : erreur signalée, boucle préservée, reprise seule", async () => {
    // logs.tail acquitté « ok » mais sans `lines` : le tail ne doit ni se
    // taire (le panneau resterait vide sans dire pourquoi) ni s'arrêter — il
    // ne tourne que tant qu'un client écoute, une boucle morte ne redémarre
    // jamais toute seule.
    const { client, sockets } = creerClient();
    client.start();
    const socket = sockets[0]!;
    handshake(socket);

    const tailer = new LogTailer(client, 10);
    const evenements: LogTailEvent[] = [];
    const desabonner = tailer.subscribe((evenement) => evenements.push(evenement));

    await attendre(() => socket.requetes("logs.tail").length > 0);
    repondreATout(socket, () => ({ ok: true, payload: { cursor: 4, size: 4 } }));
    await attendre(() => evenements.some((e) => e.type === "error"));

    // Le tick suivant repart de lui-même : la gateway se reprend, le panneau
    // aussi, sans que personne n'ait à rouvrir la page.
    await attendre(() => socket.requetes("logs.tail").length > 1);
    repondreATout(socket, () => ({
      ok: true,
      payload: { cursor: 5, size: 5, lines: ["reprise"], truncated: false, reset: false },
    }));
    await attendre(() => evenements.some((e) => e.type === "data"));

    desabonner();
    await tailer.stop();
    client.stop();

    const premier = evenements[0]!;
    expect(premier.type).toBe("error");
    expect(premier.type === "error" && premier.message).toBeTruthy();
    const donnee = evenements.find((e) => e.type === "data");
    expect(donnee?.type === "data" && donnee.result.lines).toEqual(["reprise"]);
  });
});
