// src/notify.test.ts — phase 3 de bout en bout : validation du payload,
// limitation de débit, idempotence, diffusion SSE et relais ntfy.
//
// Le relais est éprouvé contre un VRAI serveur HTTP jetable (Bun.serve sur un
// port éphémère) plutôt qu'un fetch simulé : c'est le seul moyen de vérifier ce
// que ntfy reçoit réellement — méthode, URL de publication, corps JSON,
// en-tête d'authentification — et donc la seule façon d'attraper une régression
// de format. Aucun topic ni jeton réel n'apparaît ici.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdempotencyStore,
  NotificationHub,
  NotifyService,
  RateLimiter,
  parseNotifyPayload,
  relayToNtfy,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
  NOTIFY_PAYLOAD_VERSION,
  type NotificationEvent,
  type NotifyErrorBody,
  type NotifySuccessBody,
  type NtfyConfig,
} from "./notify";

const tmpRoot = mkdtempSync(join(tmpdir(), "clawdeck-notify-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// Même précaution qu'index.test.ts : compléter l'environnement AVANT de charger
// le backend, d'où les imports dynamiques (des imports statiques seraient
// hissés au-dessus de ces lignes).
process.env.AUTH_TOKEN ??= "0123456789abcdef0123456789abcdef";
process.env.GATEWAY_URL ??= "http://127.0.0.1:59999";
process.env.GATEWAY_AUTH_TOKEN ??= "gateway-token-de-test";
process.env.GATEWAY_DEVICE_IDENTITY_PATH ??= join(tmpRoot, "identity.json");

const { getEnv, parseEnv } = await import("./env");

const validEvent = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  type: "notification",
  v: NOTIFY_PAYLOAD_VERSION,
  id: "id-de-test",
  at: 1_700_000_000_000,
  title: "Sauvegarde terminée",
  message: "12 Go copiés en 4 min.",
  severity: "info",
  tags: [],
  ...over,
});

const validPayload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  title: "Sauvegarde terminée",
  message: "12 Go copiés en 4 min.",
  ...over,
});

describe("parseNotifyPayload", () => {
  test("accepte le payload minimal et applique les défauts", () => {
    const parsed = parseNotifyPayload(validPayload());
    expect(parsed).toEqual({
      ok: true,
      value: {
        title: "Sauvegarde terminée",
        message: "12 Go copiés en 4 min.",
        severity: "info",
        tags: [],
      },
    });
  });

  test("exige la version et refuse une version inconnue avec un code distinct", () => {
    // Sans version, un émetteur d'un futur format verrait ses champs
    // réinterprétés en silence : le refus doit être explicite et distinguable
    // d'un simple champ manquant.
    expect(parseNotifyPayload({ title: "t", message: "m" })).toMatchObject({
      ok: false,
      code: "invalid-payload",
    });
    expect(parseNotifyPayload(validPayload({ v: 2 }))).toMatchObject({
      ok: false,
      code: "unsupported-version",
    });
    expect(parseNotifyPayload(validPayload({ v: "1" }))).toMatchObject({
      ok: false,
      code: "invalid-payload",
    });
  });

  test("refuse ce qui n'est pas un objet JSON", () => {
    for (const raw of [null, 42, "texte", [1, 2], true]) {
      expect(parseNotifyPayload(raw).ok).toBe(false);
    }
  });

  test("borne title et message, et refuse le vide", () => {
    expect(parseNotifyPayload(validPayload({ title: "x".repeat(MAX_TITLE_LENGTH) })).ok).toBe(true);
    expect(parseNotifyPayload(validPayload({ title: "x".repeat(MAX_TITLE_LENGTH + 1) })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ message: "x".repeat(MAX_MESSAGE_LENGTH + 1) })).ok).toBe(false);
    for (const empty of ["", "   ", 42, null, undefined]) {
      expect(parseNotifyPayload(validPayload({ title: empty })).ok).toBe(false);
      expect(parseNotifyPayload(validPayload({ message: empty })).ok).toBe(false);
    }
  });

  test("trim les champs texte", () => {
    const parsed = parseNotifyPayload(validPayload({ title: "  Titre  ", message: "  Corps  " }));
    expect(parsed.ok && parsed.value).toEqual({
      title: "Titre",
      message: "Corps",
      severity: "info",
      tags: [],
    });
  });

  test("refuse les caractères de contrôle, sauf le saut de ligne dans le message", () => {
    // Un saut de ligne dans un titre couperait la ligne de notification en
    // deux ; une séquence d'échappement ANSI ou un caractère nul n'ont leur
    // place ni dans une bulle du dashboard ni dans un push iPhone.
    expect(parseNotifyPayload(validPayload({ title: "Titre\nsur deux lignes" })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ title: "Titre\u001b[31m" })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ message: "ligne 1\nligne 2" })).ok).toBe(true);
    expect(parseNotifyPayload(validPayload({ message: "corps\u0000" })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ message: "corps\u0007" })).ok).toBe(false);
  });

  test("severity : trois valeurs, rien d'autre", () => {
    for (const severity of ["info", "warning", "error"]) {
      expect(parseNotifyPayload(validPayload({ severity })).ok).toBe(true);
    }
    for (const severity of ["critique", "INFO", 3, null]) {
      expect(parseNotifyPayload(validPayload({ severity })).ok).toBe(false);
    }
  });

  test("tags : bornés en nombre, en longueur et en alphabet", () => {
    expect(parseNotifyPayload(validPayload({ tags: ["floppy_disk", "warning"] })).ok).toBe(true);
    expect(parseNotifyPayload(validPayload({ tags: [] })).ok).toBe(true);
    expect(parseNotifyPayload(validPayload({ tags: ["a", "b", "c", "d", "e", "f"] })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ tags: ["x".repeat(25)] })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ tags: ["ok", "pas ok"] })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ tags: ["../ailleurs"] })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ tags: "warning" })).ok).toBe(false);
    expect(parseNotifyPayload(validPayload({ tags: [42] })).ok).toBe(false);
  });
});

describe("NotificationHub", () => {
  test("diffuse à tous les abonnés et compte ceux qui ont été servis", () => {
    const hub = new NotificationHub();
    const recus: NotificationEvent[] = [];
    const off1 = hub.subscribe((e) => recus.push(e));
    hub.subscribe((e) => recus.push(e));

    expect(hub.emit(validEvent())).toBe(2);
    expect(recus).toHaveLength(2);

    off1();
    expect(hub.emit(validEvent())).toBe(1);
    expect(hub.clientCount).toBe(1);
  });

  test("un abonné qui lève ne prive pas les autres", () => {
    const hub = new NotificationHub();
    hub.subscribe(() => {
      throw new Error("flux mort");
    });
    let recu = false;
    hub.subscribe(() => {
      recu = true;
    });
    expect(hub.emit(validEvent())).toBe(1);
    expect(recu).toBe(true);
  });

  test("un abonné arrivé après coup ne reçoit AUCUN historique", () => {
    // Règle d'architecture : rien n'est conservé. Ce test existe pour qu'un
    // futur « petit tampon des dernières notifications » casse ici.
    const hub = new NotificationHub();
    hub.emit(validEvent());
    const recus: NotificationEvent[] = [];
    hub.subscribe((e) => recus.push(e));
    expect(recus).toEqual([]);
  });
});

describe("RateLimiter", () => {
  test("laisse passer jusqu'au plafond puis refuse avec un délai d'attente", () => {
    let now = 1_000;
    const limiter = new RateLimiter(3, 60_000, () => now);
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(true);
    now += 10_000;
    expect(limiter.check().allowed).toBe(true);

    const refuse = limiter.check();
    expect(refuse.allowed).toBe(false);
    // La fenêtre se libère quand le plus ancien appel en sort, pas 60 s plus tard.
    expect(refuse.allowed === false && refuse.retryAfterMs).toBe(50_000);
  });

  test("la fenêtre glisse : le quota se reconstitue", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1_000, () => now);
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(false);
    now += 1_001;
    expect(limiter.check().allowed).toBe(true);
  });
});

describe("IdempotencyStore", () => {
  test("sans clé, la fabrique s'exécute à chaque fois", async () => {
    const store = new IdempotencyStore<number>(1_000, 10);
    let appels = 0;
    await store.run(null, async () => ++appels);
    await store.run(null, async () => ++appels);
    expect(appels).toBe(2);
    expect(store.size).toBe(0);
  });

  test("même clé : une seule exécution, réponse rejouée", async () => {
    const store = new IdempotencyStore<number>(1_000, 10);
    let appels = 0;
    const first = await store.run("k", async () => ++appels);
    const second = await store.run("k", async () => ++appels);
    expect(appels).toBe(1);
    expect(first).toEqual({ value: 1, replay: false });
    expect(second).toEqual({ value: 1, replay: true });
  });

  test("deux appels concurrents sur la même clé partagent une seule exécution", async () => {
    // Cas réel : un client réessaie AVANT d'avoir reçu la première réponse.
    // Mémoriser le résultat plutôt que la promesse laisserait passer deux
    // envois ntfy.
    const store = new IdempotencyStore<number>(1_000, 10);
    let appels = 0;
    const lent = async () => {
      appels++;
      await Bun.sleep(10);
      return appels;
    };
    const [a, b] = await Promise.all([store.run("k", lent), store.run("k", lent)]);
    expect(appels).toBe(1);
    expect(a?.value).toBe(1);
    expect(b?.value).toBe(1);
  });

  test("l'entrée expire après le TTL", async () => {
    let now = 0;
    const store = new IdempotencyStore<number>(1_000, 10, () => now);
    let appels = 0;
    await store.run("k", async () => ++appels);
    now += 1_001;
    const rejoue = await store.run("k", async () => ++appels);
    expect(appels).toBe(2);
    expect(rejoue.replay).toBe(false);
  });

  test("le nombre d'entrées est plafonné (la plus ancienne part)", async () => {
    const store = new IdempotencyStore<string>(60_000, 2);
    await store.run("a", async () => "a");
    await store.run("b", async () => "b");
    await store.run("c", async () => "c");
    expect(store.size).toBe(2);
    // « a » a été évincée : sa fabrique se réexécute.
    let reexecute = false;
    await store.run("a", async () => {
      reexecute = true;
      return "a";
    });
    expect(reexecute).toBe(true);
  });

  test("un échec n'est pas mis en cache", async () => {
    const store = new IdempotencyStore<string>(60_000, 10);
    await expect(
      store.run("k", async () => {
        throw new Error("panne");
      }),
    ).rejects.toThrow("panne");
    const apres = await store.run("k", async () => "ok");
    expect(apres).toEqual({ value: "ok", replay: false });
  });
});

// --- Faux serveur ntfy -------------------------------------------------------

interface NtfyCapture {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

// Serveur jetable sur un port éphémère (port: 0), lié au loopback : il ne sort
// jamais de la machine et ne demande aucun secret.
function startFakeNtfy(handler?: (req: Request) => Response | Promise<Response>) {
  const captures: NtfyCapture[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> = {};
      try {
        body = (await req.clone().json()) as Record<string, unknown>;
      } catch {
        // corps non JSON : la capture reste vide, le test l'assertera
      }
      captures.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      return handler ? handler(req) : new Response("ok");
    },
  });
  return {
    captures,
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}

describe("relayToNtfy", () => {
  test("sans configuration : état « non configuré », jamais un échec", async () => {
    const result = await relayToNtfy(null, validEvent());
    expect(result.state).toBe("not-configured");
    expect(result.detail).toContain(".env");
  });

  test("publie en JSON sur la racine du serveur, topic dans le corps", async () => {
    const ntfy = startFakeNtfy();
    try {
      const config: NtfyConfig = { url: ntfy.url, topic: "topic-de-test", token: null };
      const result = await relayToNtfy(
        config,
        validEvent({ title: "Sauvegarde terminée", severity: "warning", tags: ["warning"] }),
      );
      expect(result).toEqual({ state: "sent" });

      const capture = ntfy.captures[0];
      expect(capture?.method).toBe("POST");
      // Racine, et non /<topic> : c'est le mode JSON de ntfy, seul capable de
      // porter un titre accentué (les en-têtes HTTP sont limités à l'ASCII).
      expect(capture?.path).toBe("/");
      expect(capture?.contentType).toContain("application/json");
      expect(capture?.body).toEqual({
        topic: "topic-de-test",
        title: "Sauvegarde terminée",
        message: "12 Go copiés en 4 min.",
        priority: 4,
        tags: ["warning"],
      });
      // Topic public : aucun en-tête d'authentification inventé.
      expect(capture?.authorization).toBeNull();
    } finally {
      ntfy.stop();
    }
  });

  test("le titre accentué arrive intact", async () => {
    const ntfy = startFakeNtfy();
    try {
      await relayToNtfy(
        { url: ntfy.url, topic: "t", token: null },
        validEvent({ title: "Élévation de privilèges détectée", message: "Àéîõü — ok" }),
      );
      expect(ntfy.captures[0]?.body.title).toBe("Élévation de privilèges détectée");
      expect(ntfy.captures[0]?.body.message).toBe("Àéîõü — ok");
    } finally {
      ntfy.stop();
    }
  });

  test("severity → priorité ntfy", async () => {
    const ntfy = startFakeNtfy();
    try {
      const config: NtfyConfig = { url: ntfy.url, topic: "t", token: null };
      await relayToNtfy(config, validEvent({ severity: "info" }));
      await relayToNtfy(config, validEvent({ severity: "warning" }));
      await relayToNtfy(config, validEvent({ severity: "error" }));
      expect(ntfy.captures.map((c) => c.body.priority)).toEqual([3, 4, 5]);
    } finally {
      ntfy.stop();
    }
  });

  test("topic privé : le jeton part en Bearer et ne revient jamais dans la réponse", async () => {
    const ntfy = startFakeNtfy(() => new Response("refusé", { status: 403 }));
    try {
      const secret = "jeton-ntfy-factice-0123456789";
      const result = await relayToNtfy({ url: ntfy.url, topic: "t", token: secret }, validEvent());
      expect(ntfy.captures[0]?.authorization).toBe(`Bearer ${secret}`);
      expect(result.state).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.detail).toContain("NTFY_TOKEN");
    } finally {
      ntfy.stop();
    }
  });

  test("réponse non 2xx : échec avec un diagnostic actionnable", async () => {
    for (const [status, attendu] of [
      [404, "introuvable"],
      [429, "quota"],
      [503, "indisponible"],
    ] as const) {
      const ntfy = startFakeNtfy(() => new Response("", { status }));
      try {
        const result = await relayToNtfy({ url: ntfy.url, topic: "t", token: null }, validEvent());
        expect(result.state).toBe("failed");
        expect(result.detail).toContain(attendu);
      } finally {
        ntfy.stop();
      }
    }
  });

  test("serveur muet : échec sur délai dépassé, jamais une requête suspendue", async () => {
    const ntfy = startFakeNtfy(async () => {
      await Bun.sleep(5_000);
      return new Response("trop tard");
    });
    try {
      const result = await relayToNtfy(
        { url: ntfy.url, topic: "t", token: null },
        validEvent(),
        { timeoutMs: 50 },
      );
      expect(result.state).toBe("failed");
      expect(result.detail).toContain("sans réponse");
    } finally {
      ntfy.stop();
    }
  });

  test("serveur injoignable : échec net", async () => {
    // Port fermé : rien n'écoute, le fetch rejette immédiatement.
    const result = await relayToNtfy(
      { url: "http://127.0.0.1:1/", topic: "t", token: null },
      validEvent(),
      { timeoutMs: 500 },
    );
    expect(result.state).toBe("failed");
    expect(result.detail).toContain("injoignable");
  });
});

// --- Service complet ---------------------------------------------------------

describe("NotifyService", () => {
  const success = (body: NotifySuccessBody | NotifyErrorBody) => body as NotifySuccessBody;
  const failure = (body: NotifySuccessBody | NotifyErrorBody) => body as NotifyErrorBody;

  let hub: NotificationHub;
  let recus: NotificationEvent[];

  beforeEach(() => {
    hub = new NotificationHub();
    recus = [];
    hub.subscribe((e) => recus.push(e));
  });

  test("relais non configuré : 200, diffusion locale, état explicite", async () => {
    const service = new NotifyService({ hub, ntfy: null });
    const res = await service.submit(validPayload(), null);
    expect(res.status).toBe(200);
    expect(success(res.body).local).toEqual({ delivered: true, clients: 1 });
    expect(success(res.body).ntfy.state).toBe("not-configured");
    expect(recus).toHaveLength(1);
    expect(recus[0]?.title).toBe("Sauvegarde terminée");
    expect(recus[0]?.type).toBe("notification");
  });

  test("aucun navigateur connecté : delivered=false, mais toujours 200", async () => {
    const service = new NotifyService({ hub: new NotificationHub(), ntfy: null });
    const res = await service.submit(validPayload(), null);
    expect(res.status).toBe(200);
    expect(success(res.body).local).toEqual({ delivered: false, clients: 0 });
  });

  test("ntfy en échec : 207, la moitié réussie reste rapportée telle quelle", async () => {
    const ntfy = startFakeNtfy(() => new Response("", { status: 500 }));
    try {
      const service = new NotifyService({
        hub,
        ntfy: { url: ntfy.url, topic: "t", token: null },
      });
      const res = await service.submit(validPayload(), null);
      // 207 et non 200 : un succès global masquerait la perte du push.
      // 207 et non 5xx : la diffusion locale, elle, a bien eu lieu.
      expect(res.status).toBe(207);
      expect(success(res.body).local.delivered).toBe(true);
      expect(success(res.body).ntfy.state).toBe("failed");
      expect(recus).toHaveLength(1);
    } finally {
      ntfy.stop();
    }
  });

  test("ntfy joignable : 200 et notification réellement publiée", async () => {
    const ntfy = startFakeNtfy();
    try {
      const service = new NotifyService({
        hub,
        ntfy: { url: ntfy.url, topic: "topic-de-test", token: null },
      });
      const res = await service.submit(validPayload({ tags: ["floppy_disk"] }), null);
      expect(res.status).toBe(200);
      expect(success(res.body).ntfy).toEqual({ state: "sent" });
      expect(ntfy.captures[0]?.body.topic).toBe("topic-de-test");
      expect(ntfy.captures[0]?.body.tags).toEqual(["floppy_disk"]);
    } finally {
      ntfy.stop();
    }
  });

  test("payload invalide : 400, rien de diffusé ni de relayé", async () => {
    const ntfy = startFakeNtfy();
    try {
      const service = new NotifyService({ hub, ntfy: { url: ntfy.url, topic: "t", token: null } });
      const res = await service.submit({ title: "sans version", message: "m" }, null);
      expect(res.status).toBe(400);
      expect(failure(res.body).code).toBe("invalid-payload");
      expect(recus).toEqual([]);
      expect(ntfy.captures).toEqual([]);
    } finally {
      ntfy.stop();
    }
  });

  test("clé d'idempotence malformée : 400 avant toute diffusion", async () => {
    const service = new NotifyService({ hub, ntfy: null });
    for (const key of ["clé avec espace", "x".repeat(129), " "]) {
      const res = await service.submit(validPayload(), key);
      expect(res.status).toBe(400);
      expect(failure(res.body).code).toBe("invalid-idempotency-key");
    }
    expect(recus).toEqual([]);
  });

  test("même clé d'idempotence : une seule diffusion, une seule publication ntfy", async () => {
    const ntfy = startFakeNtfy();
    try {
      const service = new NotifyService({
        hub,
        ntfy: { url: ntfy.url, topic: "t", token: null },
      });
      const first = await service.submit(validPayload(), "sauvegarde-2026-07-25");
      const second = await service.submit(validPayload(), "sauvegarde-2026-07-25");

      expect(recus).toHaveLength(1);
      expect(ntfy.captures).toHaveLength(1);
      expect(success(first.body).replay).toBe(false);
      expect(success(second.body).replay).toBe(true);
      // Réponse rejouée à l'identique : même identifiant, même horodatage.
      expect(success(second.body).id).toBe(success(first.body).id);
      expect(success(second.body).at).toBe(success(first.body).at);
      expect(second.status).toBe(first.status);
    } finally {
      ntfy.stop();
    }
  });

  test("clés différentes : deux notifications distinctes", async () => {
    const service = new NotifyService({ hub, ntfy: null });
    await service.submit(validPayload(), "cle-a");
    await service.submit(validPayload(), "cle-b");
    expect(recus).toHaveLength(2);
    expect(recus[0]?.id).not.toBe(recus[1]?.id);
  });

  test("au-delà du quota : 429 avec Retry-After, et plus rien ne part", async () => {
    let now = 0;
    const service = new NotifyService({
      hub,
      ntfy: null,
      now: () => now,
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
    });
    expect((await service.submit(validPayload(), null)).status).toBe(200);
    expect((await service.submit(validPayload(), null)).status).toBe(200);

    const refuse = await service.submit(validPayload(), null);
    expect(refuse.status).toBe(429);
    expect(failure(refuse.body).code).toBe("rate-limited");
    expect(refuse.retryAfterSeconds).toBe(60);
    expect(recus).toHaveLength(2);

    now += 60_001;
    expect((await service.submit(validPayload(), null)).status).toBe(200);
  });

  test("identifiant et horodatage propres à chaque notification", async () => {
    const service = new NotifyService({ hub, ntfy: null, now: () => 1_700_000_000_000 });
    const res = await service.submit(validPayload(), null);
    expect(success(res.body).at).toBe(1_700_000_000_000);
    expect(success(res.body).id).toMatch(/^[0-9a-f-]{36}$/);
    expect(success(res.body).v).toBe(NOTIFY_PAYLOAD_VERSION);
  });
});

// --- Configuration .env ------------------------------------------------------

describe("parseEnv — relais ntfy", () => {
  const base = (over: Record<string, string | undefined> = {}) => ({
    AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
    GATEWAY_AUTH_TOKEN: "gateway-secret-token",
    GATEWAY_URL: "http://127.0.0.1:8080",
    ...over,
  });

  test("absent des variables : relais null, pas d'erreur de démarrage", () => {
    expect(parseEnv(base()).ntfy).toBeNull();
    expect(parseEnv(base({ NTFY_URL: "", NTFY_TOPIC: "  " })).ntfy).toBeNull();
  });

  test("configuration complète : URL normalisée avec « / » final", () => {
    expect(parseEnv(base({ NTFY_URL: "https://ntfy.exemple", NTFY_TOPIC: "clawdeck-prive" })).ntfy).toEqual({
      url: "https://ntfy.exemple/",
      topic: "clawdeck-prive",
      token: null,
    });
    expect(
      parseEnv(base({ NTFY_URL: "https://ntfy.exemple/base", NTFY_TOPIC: "t", NTFY_TOKEN: "tk_factice" })).ntfy,
    ).toEqual({ url: "https://ntfy.exemple/base/", topic: "t", token: "tk_factice" });
  });

  test("configuration à moitié remplie : erreur de démarrage, jamais un relais muet", () => {
    expect(() => parseEnv(base({ NTFY_URL: "https://ntfy.exemple" }))).toThrow(/NTFY_TOPIC/);
    expect(() => parseEnv(base({ NTFY_TOPIC: "t" }))).toThrow(/NTFY_URL/);
    expect(() => parseEnv(base({ NTFY_TOKEN: "tk_factice" }))).toThrow(/NTFY_TOKEN/);
  });

  test("refuse une NTFY_URL malformée, non http(s), avec identifiants ou paramètres", () => {
    for (const url of [
      "pas une url",
      "ftp://ntfy.exemple",
      "https://utilisateur:motdepasse@ntfy.exemple",
      "https://ntfy.exemple/?auth=abc",
      "https://ntfy.exemple/#ancre",
    ]) {
      expect(() => parseEnv(base({ NTFY_URL: url, NTFY_TOPIC: "t" }))).toThrow(/NTFY_URL/);
    }
  });

  test("ne divulgue jamais les identifiants d'une NTFY_URL rejetée", () => {
    const secret = "motdepasse-tres-secret";
    try {
      parseEnv(base({ NTFY_URL: `https://user:${secret}@ntfy.exemple`, NTFY_TOPIC: "t" }));
      throw new Error("aurait dû lever");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("refuse un topic qui n'est pas un nom simple", () => {
    for (const topic of ["avec/slash", "avec espace", "trop" + "x".repeat(64), "accentué"]) {
      expect(() => parseEnv(base({ NTFY_URL: "https://ntfy.exemple", NTFY_TOPIC: topic }))).toThrow(
        /NTFY_TOPIC/,
      );
    }
  });

  test("refuse la valeur d'exemple NTFY_TOKEN=change-me", () => {
    expect(() =>
      parseEnv(base({ NTFY_URL: "https://ntfy.exemple", NTFY_TOPIC: "t", NTFY_TOKEN: "change-me" })),
    ).toThrow(/NTFY_TOKEN/);
  });
});

// --- Routes HTTP -------------------------------------------------------------
//
// Exercées via app.request(), comme index.test.ts. Attention : le service de
// notification est un singleton du module, donc SON compteur de débit est
// partagé par tous les tests de ce fichier — 20 requêtes par minute au total.
// Les cas ci-dessous en consomment une poignée ; le dernier bloc épuise
// volontairement ce qui reste et doit donc rester en fin de fichier.

const { app } = await import("./index");
const auth = { Authorization: `Bearer ${getEnv().authToken}` };

const postNotify = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/notify", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const jsonOf = async (res: Response) => (await res.json()) as Record<string, any>;

describe("POST /api/notify", () => {
  test("la garde bearer couvre les deux routes de notification", async () => {
    for (const path of ["/api/notify", "/api/notifications"]) {
      const res = await app.request(path, path === "/api/notify" ? { method: "POST" } : {});
      expect(res.status).toBe(401);
    }
  });

  test("413 sur un content-length au-delà de la borne, avant de lire le corps", async () => {
    const res = await postNotify("{pas du json", { "content-length": "999999" });
    expect(res.status).toBe(413);
    expect((await jsonOf(res)).code).toBe("body-too-large");
  });

  test("413 sur un corps réellement trop gros", async () => {
    const res = await postNotify({ v: 1, title: "t", message: "x".repeat(20_000) });
    expect(res.status).toBe(413);
  });

  test("400 sur un corps qui n'est pas du JSON", async () => {
    const res = await postNotify("{ceci n'est pas du json");
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).code).toBe("invalid-json");
  });

  test("diffuse réellement sur /api/notifications et répond 200", async () => {
    const controller = new AbortController();
    const stream = await app.request("/api/notifications", {
      headers: auth,
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);

    try {
      // Commentaire d'ouverture : il prouve que le flux est vivant et garantit
      // que l'abonnement est en place avant que la notification ne parte.
      expect(await next()).toBe(": ouverture\n\n");

      const res = await postNotify({
        v: 1,
        title: "Sauvegarde terminée",
        message: "12 Go copiés.",
        severity: "warning",
      });
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.local).toEqual({ delivered: true, clients: 1 });
      // Sans NTFY_* dans l'environnement de test, le relais se déclare
      // explicitement non configuré — jamais en échec.
      expect(body.ntfy.state).toBe("not-configured");

      const frame = await next();
      expect(frame.startsWith("event: notification\n")).toBe(true);
      const data = JSON.parse(frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
      expect(data).toEqual({
        type: "notification",
        v: 1,
        id: body.id,
        at: body.at,
        title: "Sauvegarde terminée",
        message: "12 Go copiés.",
        severity: "warning",
        tags: [],
      });
    } finally {
      // Annuler la lecture déclenche l'abandon du flux côté serveur (onAbort) :
      // sans cela le keep-alive périodique tiendrait la boucle d'événements
      // ouverte et `bun test` ne rendrait jamais la main.
      await reader.cancel();
      controller.abort();
    }
  });
});

describe("POST /api/notify — quota", () => {
  test("429 avec Retry-After une fois le quota épuisé", async () => {
    // Épuise ce qui reste du compteur partagé : ce bloc est le dernier du
    // fichier pour cette raison.
    let last = await postNotify({ v: 1, title: "t", message: "m" });
    for (let i = 0; i < 25 && last.status !== 429; i++) {
      last = await postNotify({ v: 1, title: "t", message: "m" });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = await jsonOf(last);
    expect(body.code).toBe("rate-limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
