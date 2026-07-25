// src/index.test.ts — routes HTTP du backend exercées via app.request() :
// garde bearer, /api/pings/history et les codes d'erreur typés de
// /api/workspace. Importer index.ts ne démarre plus rien (le bootstrap y est
// sous `import.meta.main`) : aucun port n'est ouvert, aucune connexion gateway
// tentée, et la base SQLite de production — un fichier unique partagé avec le
// backend en cours d'exécution — est remplacée par une base en mémoire.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_WORKSPACE_FILE_BYTES } from "./workspace";

const tmpRoot = mkdtempSync(join(tmpdir(), "clawdeck-api-"));
const workspaceRoot = join(tmpRoot, "workspace");
mkdirSync(workspaceRoot);
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// src/env.ts valide process.env au moment où il est évalué : sans .env — le cas
// de la CI — le simple import du backend échouerait. On complète donc ce qui
// manque AVANT tout chargement, d'où des imports dynamiques : des imports
// statiques seraient hissés au-dessus de ces lignes. Une configuration déjà
// présente (poste de dev) est laissée intacte, y compris son AUTH_TOKEN, que
// les tests relisent depuis le module plutôt que de le supposer.
process.env.AUTH_TOKEN ??= "0123456789abcdef0123456789abcdef";
process.env.GATEWAY_URL ??= "http://127.0.0.1:59999";
process.env.GATEWAY_AUTH_TOKEN ??= "gateway-token-de-test";
process.env.GATEWAY_DEVICE_IDENTITY_PATH ??= join(tmpRoot, "identity.json");

const { getEnv } = await import("./env");
const env = getEnv();
const { createPingStore, usePingStore } = await import("./db");
const { app, gateway } = await import("./index");

const auth = { Authorization: `Bearer ${env.authToken}` };

interface GatewayStub {
  connected?: boolean;
  listing?: (path?: string) => Promise<unknown>;
  file?: (path: string) => Promise<unknown>;
  agent?: () => Promise<{ id: string; workspace: string | null } | null>;
}

// Les routes /api/workspace n'ont qu'une dépendance externe : l'instance
// gateway exportée. On substitue ses accès sur l'instance elle-même (le getter
// isConnected est masqué par une propriété propre), ce qui laisse tourner le
// VRAI code des routes — validation, mapping d'erreurs, écriture disque.
function stubGateway(stub: GatewayStub = {}) {
  Object.defineProperty(gateway, "isConnected", {
    configurable: true,
    get: () => stub.connected ?? true,
  });
  gateway.getWorkspaceListing = stub.listing ?? (async () => ({ entries: [] }));
  gateway.getWorkspaceFile = stub.file ?? (async () => ({ file: null }));
  gateway.getDefaultAgent =
    stub.agent ?? (async () => ({ id: "main", workspace: workspaceRoot }));
}

// Base neuve à chaque test : l'historique d'un test ne doit pas se retrouver
// dans les assertions du suivant. Installée dès le chargement du module et
// jamais retirée, pour qu'aucun appel — même tardif — ne puisse rouvrir celle
// de production.
let pings = createPingStore(new Database(":memory:"));
usePingStore(pings);

beforeEach(() => {
  pings = createPingStore(new Database(":memory:"));
  usePingStore(pings);
  stubGateway();
});

const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("garde bearer sur /api/*", () => {
  test("refuse une requête sans en-tête Authorization", async () => {
    const res = await app.request("/api/pings/history");
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "unauthorized" });
  });

  test("refuse tout ce qui n'est pas exactement « Bearer <token> »", async () => {
    const token = env.authToken;
    for (const value of [
      "",
      "Bearer ",
      "Bearer mauvais-token",
      token, // sans le schéma
      `bearer ${token}`, // schéma en minuscules : comparé tel quel
      `Bearer  ${token}`, // espace surnuméraire
      `Bearer ${token}x`, // plus long d'un caractère
      `Bearer ${token.slice(0, -1)}`, // préfixe correct, longueur différente
      `Bearer ${token.slice(0, -1)}${token.at(-1) === "a" ? "b" : "a"}`, // même longueur, dernier octet faux
    ]) {
      const res = await app.request("/api/pings/history", {
        headers: { Authorization: value },
      });
      expect(res.status).toBe(401);
    }
  });

  test("un token de longueur différente ne fait pas planter la comparaison", async () => {
    // timingSafeEqual lève si les deux tampons n'ont pas la même taille : la
    // longueur doit être écartée AVANT l'appel, sinon un token trop court
    // renvoie 500 au lieu de 401.
    for (const value of ["Bearer x", `Bearer ${"z".repeat(4096)}`]) {
      const res = await app.request("/api/pings/history", {
        headers: { Authorization: value },
      });
      expect(res.status).toBe(401);
    }
  });

  test("ne divulgue jamais le token attendu dans une réponse 401", async () => {
    const res = await app.request("/api/pings/history", {
      headers: { Authorization: "Bearer mauvais-token" },
    });
    const body = await res.text();
    expect(body).not.toContain(env.authToken);
    expect(JSON.stringify([...res.headers])).not.toContain(env.authToken);
  });

  test("laisse passer le bon token", async () => {
    const res = await app.request("/api/pings/history", { headers: auth });
    expect(res.status).toBe(200);
  });

  test("le handshake WS reste la seule route de chat accessible sans token", async () => {
    // Un navigateur ne peut pas poser d'en-tête sur un handshake WebSocket :
    // /api/chat/ws s'authentifie à la première frame. Hors de Bun.serve,
    // l'upgrade est simulé — que le faux serveur soit sollicité prouve que la
    // requête a atteint le handler au lieu d'être arrêtée par la garde bearer
    // (un simple « pas 401 » se contenterait du repli SPA).
    let upgradeDemande = false;
    const res = await app.request(
      "/api/chat/ws",
      {},
      {
        server: {
          upgrade: () => {
            upgradeDemande = true;
            return true;
          },
        },
      },
    );
    expect(upgradeDemande).toBe(true);
    expect(res.status).not.toBe(401);
  });
});

describe("/api/pings/history", () => {
  test("hours non numérique : 400, et rien n'atteint SQLite", async () => {
    for (const hours of ["abc", "Infinity", "NaN", "12h"]) {
      const res = await app.request(`/api/pings/history?hours=${hours}`, {
        headers: auth,
      });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid hours" });
    }
  });

  test("sans paramètre : fenêtre 24 h et bucket de 240 s (~360 points)", async () => {
    for (const url of ["/api/pings/history", "/api/pings/history?hours="]) {
      const body = await json(await app.request(url, { headers: auth }));
      expect(body.bucketMs).toBe(240_000);
      expect(Object.keys(body).sort()).toEqual([
        "bucketMs",
        "cloudflare",
        "orange",
        "remote",
      ]);
    }
  });

  test("borne la fenêtre à 7 jours et le bucket reste ~fenêtre/360", async () => {
    const body = await json(
      await app.request("/api/pings/history?hours=99999", { headers: auth }),
    );
    // 7 j / 360 : au-delà, la demande est écrêtée, jamais transmise telle quelle.
    expect(body.bucketMs).toBe(Math.round((7 * 24 * 60 * 60 * 1000) / 360));
  });

  test("borne basse : moins d'une heure demandée reste une heure", async () => {
    for (const hours of ["0", "-5", "0.001"]) {
      const body = await json(
        await app.request(`/api/pings/history?hours=${hours}`, { headers: auth }),
      );
      expect(body.bucketMs).toBe(10_000);
    }
  });

  test("renvoie les mesures agrégées, cible par cible", async () => {
    // Horloge figée : deux insertions qui tomberaient de part et d'autre d'une
    // frontière de bucket (10 s ici) rendraient l'assertion intermittente.
    const instant = Date.now();
    pings = createPingStore(new Database(":memory:"), () => instant);
    usePingStore(pings);
    pings.insertPing("cloudflare", "1.1.1.1", true, 12);
    pings.insertPing("cloudflare", "1.1.1.1", true, 14);
    pings.insertPing("orange", "192.168.1.1", false, null);

    const body = await json(
      await app.request("/api/pings/history?hours=1", { headers: auth }),
    );
    expect(body.cloudflare).toHaveLength(1);
    expect(body.cloudflare[0].latencyMs).toBe(13);
    expect(body.cloudflare[0].ok).toBe(1);
    // Horodatage aligné sur la borne basse du bucket, comme le graphe l'attend.
    expect(body.orange).toEqual([
      { ts: Math.floor(instant / 10_000) * 10_000, ok: 0, latencyMs: null },
    ]);
    // Cible jamais sondée : série vide, jamais absente (le front trace trois
    // courbes en permanence).
    expect(body.remote).toEqual([]);
  });

  test("une base vide renvoie trois séries vides, pas une erreur", async () => {
    const body = await json(
      await app.request("/api/pings/history?hours=24", { headers: auth }),
    );
    expect([body.cloudflare, body.orange, body.remote]).toEqual([[], [], []]);
  });
});

describe("GET /api/workspace", () => {
  test("503 quand la gateway est déconnectée", async () => {
    stubGateway({ connected: false });
    const res = await app.request("/api/workspace", { headers: auth });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toContain("gateway");
  });

  test("502 quand la gateway répond en erreur", async () => {
    stubGateway({
      listing: async () => {
        throw new Error("agents.workspace.list a échoué");
      },
    });
    const res = await app.request("/api/workspace", { headers: auth });
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("agents.workspace.list a échoué");
  });

  test("masque .git et recalcule le total quand la gateway ne le donne pas", async () => {
    stubGateway({
      listing: async () => ({
        path: "docs",
        entries: [{ name: ".git" }, { name: "notes.md" }, { name: "img.png" }],
      }),
    });
    const body = await json(await app.request("/api/workspace?path=docs", { headers: auth }));
    // Le dépôt git du workspace n'est jamais navigable depuis le dashboard
    // (cohérent avec le refus d'écriture dans .git, voir workspace.ts).
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual([
      "notes.md",
      "img.png",
    ]);
    expect(body.totalEntries).toBe(2);
    expect(body.path).toBe("docs");
  });

  test("réponse gateway vide : listing vide et chemin demandé conservé", async () => {
    stubGateway({ listing: async () => null });
    const body = await json(
      await app.request("/api/workspace?path=sous/dossier", { headers: auth }),
    );
    expect(body).toEqual({ path: "sous/dossier", entries: [], totalEntries: 0 });
  });
});

describe("GET /api/workspace/file", () => {
  test("400 sans paramètre path", async () => {
    const res = await app.request("/api/workspace/file", { headers: auth });
    expect(res.status).toBe(400);
  });

  test("503 quand la gateway est déconnectée", async () => {
    stubGateway({ connected: false });
    const res = await app.request("/api/workspace/file?path=notes.md", { headers: auth });
    expect(res.status).toBe(503);
  });

  test("404 quand la gateway ne renvoie aucun fichier", async () => {
    stubGateway({ file: async () => ({}) });
    const res = await app.request("/api/workspace/file?path=absent.md", { headers: auth });
    expect(res.status).toBe(404);
  });

  test("404 quand le message d'erreur gateway dit l'absence, 502 sinon", async () => {
    // La gateway ne renvoie pas de code typé pour ce RPC : le mapping repose
    // sur le message, en français comme en anglais.
    for (const message of ["file not found", "fichier introuvable", "no such file"]) {
      stubGateway({
        file: async () => {
          throw new Error(message);
        },
      });
      const res = await app.request("/api/workspace/file?path=absent.md", { headers: auth });
      expect(res.status).toBe(404);
    }

    stubGateway({
      file: async () => {
        throw new Error("timeout de la gateway");
      },
    });
    const res = await app.request("/api/workspace/file?path=notes.md", { headers: auth });
    expect(res.status).toBe(502);
  });

  test("relaie le fichier tel quel quand la gateway répond", async () => {
    const file = { path: "notes.md", name: "notes.md", encoding: "utf8", content: "bonjour" };
    stubGateway({ file: async () => ({ file }) });
    const res = await app.request("/api/workspace/file?path=notes.md", { headers: auth });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ file });
  });
});

describe("POST /api/workspace/files", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/workspace/files", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("413 sur un content-length au-delà de la borne brute, avant de lire le corps", async () => {
    // Corps volontairement illisible : un 400 « JSON invalide » signifierait
    // que le backend a parsé 20 Mo annoncés avant de les refuser.
    const res = await post("{pas du json", { "content-length": "20000000" });
    expect(res.status).toBe(413);
  });

  test("400 sur un corps qui n'est pas du JSON", async () => {
    const res = await post("{ceci n'est pas du json");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("JSON invalide");
  });

  test("400 sans chemin, sans contenu, ou avec les deux contenus", async () => {
    for (const body of [
      {},
      { path: "notes.md" },
      { contentText: "bonjour" },
      { path: "", contentText: "bonjour" },
      { path: "notes.md", contentText: "bonjour", contentBase64: "Ym9uam91cg==" },
      { path: 42, contentText: "bonjour" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
  });

  test("503 quand la gateway est déconnectée ou l'agent sans workspace", async () => {
    stubGateway({ connected: false });
    expect((await post({ path: "a.md", contentText: "x" })).status).toBe(503);

    // Gateway connectée mais agents.list muet : la racine du workspace est
    // inconnue, donc rien n'est écrit sur le disque.
    stubGateway({ agent: async () => null });
    expect((await post({ path: "a.md", contentText: "x" })).status).toBe(503);

    stubGateway({ agent: async () => ({ id: "main", workspace: null }) });
    expect((await post({ path: "a.md", contentText: "x" })).status).toBe(503);

    // Racine annoncée mais absente du disque : erreur typée root-unavailable.
    stubGateway({ agent: async () => ({ id: "main", workspace: join(tmpRoot, "jamais-cree") }) });
    const res = await post({ path: "a.md", contentText: "x" });
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("root-unavailable");
  });

  test("écrit réellement le fichier, refuse le doublon en 409, l'accepte avec overwrite", async () => {
    const create = await post({ path: "notes/idee.md", contentText: "bonjour" });
    expect(create.status).toBe(200);
    expect(await json(create)).toEqual({
      created: true,
      path: "notes/idee.md",
      bytes: 7,
    });
    expect(readFileSync(join(workspaceRoot, "notes/idee.md"), "utf8")).toBe("bonjour");

    const duplicate = await post({ path: "notes/idee.md", contentText: "encore" });
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).code).toBe("exists");
    // Le contenu d'origine est intact : un 409 ne doit rien avoir écrit.
    expect(readFileSync(join(workspaceRoot, "notes/idee.md"), "utf8")).toBe("bonjour");

    const forced = await post({
      path: "notes/idee.md",
      contentText: "version 2",
      overwrite: true,
    });
    expect(forced.status).toBe(200);
    expect(readFileSync(join(workspaceRoot, "notes/idee.md"), "utf8")).toBe("version 2");
  });

  test("décode le contenu base64 tel quel", async () => {
    const res = await post({
      path: "bin/donnees.txt",
      contentBase64: Buffer.from("contenu binaire").toString("base64"),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(workspaceRoot, "bin/donnees.txt"), "utf8")).toBe("contenu binaire");
  });

  test("400 code invalid-path pour un chemin qui sort du workspace", async () => {
    for (const path of ["../evasion.md", "/etc/passwd", ".git/hooks/post-commit", "a\\b.md"]) {
      const res = await post({ path, contentText: "charge utile" });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("invalid-path");
    }
    expect(existsSync(join(tmpRoot, "evasion.md"))).toBe(false);
  });

  test("413 code too-large au-delà de 10 Mo utiles", async () => {
    // Un caractère = un octet UTF-8 : le dépassement se joue à l'octet près,
    // côté saveWorkspaceFile et non sur la borne brute du corps (15 Mo).
    const res = await post({
      path: "gros.txt",
      contentText: "x".repeat(MAX_WORKSPACE_FILE_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect((await json(res)).code).toBe("too-large");
    expect(existsSync(join(workspaceRoot, "gros.txt"))).toBe(false);
  });
});
