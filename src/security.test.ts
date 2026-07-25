import { expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CONTENT_SECURITY_POLICY,
  CSP_DIRECTIVES,
  HEALTHZ_PATH,
  SECURITY_HEADERS,
  UNAUTHENTICATED_API_PATHS,
  apiBearerAuth,
  healthz,
  securityHeaders,
} from "./security";

const TOKEN = "token-de-test-32-caracteres-ok!!";

// Reproduit le câblage de src/index.ts : en-têtes d'abord, puis auth, puis les
// trois formes de réponse que le backend produit réellement (JSON, flux SSE,
// fichier statique renvoyé sous forme de Response brute).
function testApp() {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.use("/api/*", apiBearerAuth(TOKEN));
  app.get(HEALTHZ_PATH, healthz);
  app.get("/api/pings/history", (c) => c.json({ cloudflare: [] }));
  app.get("/api/logs", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "logs", data: "{}" });
    }),
  );
  app.get("/api/chat/ws", (c) => c.json({ upgrade: "simulé" }));
  app.get("/index.html", () => new Response("<!doctype html>", {
    headers: { "Content-Type": "text/html" },
  }));
  return app;
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

test("les en-têtes de sécurité couvrent le front, l'API et les flux SSE", async () => {
  const app = testApp();
  const responses = await Promise.all([
    app.request("/index.html"),
    app.request("/api/pings/history", { headers: bearer }),
    app.request("/api/logs", { headers: bearer }),
  ]);

  for (const res of responses) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  }
});

test("les en-têtes sont posés même sur une réponse 401", async () => {
  const res = await testApp().request("/api/pings/history");
  expect(res.status).toBe(401);
  expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("la CSP autorise ce que le front charge vraiment", () => {
  // Polices woff2 auto-hébergées, SSE + WebSocket de même origine, aperçu
  // d'image en data: (onglet Fichiers) : casser l'un de ces trois points
  // casserait une fonctionnalité livrée.
  expect(CSP_DIRECTIVES["font-src"]).toBe("'self'");
  expect(CSP_DIRECTIVES["connect-src"]).toBe("'self'");
  expect(CSP_DIRECTIVES["img-src"]).toContain("data:");
  expect(CSP_DIRECTIVES["default-src"]).toBe("'self'");
});

test("la CSP autorise les blob: des médias du chat", () => {
  // /api/media exige le bearer token, or <img>/<audio> ne posent pas
  // d'en-tête : le front récupère l'octet par fetch et expose un blob local.
  // `media-src` DOIT être explicite — sans elle, la directive retombe sur
  // default-src et les vocaux WhatsApp sont bloqués (constaté à l'exécution
  // le 2026-07-25, une lecture du seul code laissait croire l'inverse).
  expect(CSP_DIRECTIVES["img-src"]).toContain("blob:");
  expect(CSP_DIRECTIVES["media-src"]).toContain("blob:");
  expect(CSP_DIRECTIVES["media-src"]).toContain("'self'");
});

test("la CSP interdit le script inline, l'encadrement et la réécriture de base", () => {
  expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
  expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  expect(CSP_DIRECTIVES["frame-ancestors"]).toBe("'none'");
  expect(CSP_DIRECTIVES["object-src"]).toBe("'none'");
  expect(CSP_DIRECTIVES["base-uri"]).toBe("'none'");
  expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
});

test("la CSP ne force jamais https sur un dashboard servi en http", () => {
  // Un tailnet privé n'a pas de certificat : upgrade-insecure-requests ou HSTS
  // rendraient le dashboard inaccessible (voir CLAUDE.md).
  expect(CONTENT_SECURITY_POLICY).not.toContain("upgrade-insecure-requests");
  expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBeUndefined();
});

test("l'API n'est jamais mise en cache, le front reste cacheable", async () => {
  const app = testApp();
  const api = await app.request("/api/pings/history", { headers: bearer });
  expect(api.headers.get("Cache-Control")).toBe("no-store");

  const sse = await app.request("/api/logs", { headers: bearer });
  expect(sse.headers.get("Cache-Control")).toBe("no-store");

  const front = await app.request("/index.html");
  expect(front.headers.get("Cache-Control")).toBe(null);
});

test("l'auth bearer refuse l'absence de token, un mauvais token et un schéma exotique", async () => {
  const app = testApp();
  for (const headers of [
    undefined,
    { Authorization: "Bearer mauvais-token" },
    { Authorization: TOKEN },
    { Authorization: `Basic ${TOKEN}` },
  ]) {
    const res = await app.request("/api/pings/history", headers ? { headers } : undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }

  const ok = await app.request("/api/pings/history", { headers: bearer });
  expect(ok.status).toBe(200);
});

test("seules la sonde de vie et le handshake WS échappent à l'auth", async () => {
  expect(UNAUTHENTICATED_API_PATHS).toEqual(["/api/chat/ws", "/api/healthz"]);

  const app = testApp();
  for (const path of UNAUTHENTICATED_API_PATHS) {
    const res = await app.request(path);
    expect(res.status).toBe(200);
  }
});

test("/api/healthz répond sans token et ne divulgue que la vie du process", async () => {
  const res = await testApp().request(HEALTHZ_PATH);
  expect(res.status).toBe(200);

  const body = (await res.json()) as Record<string, unknown>;
  // Égalité stricte : la moindre ajout de version, chemin, uptime ou état
  // gateway ferait échouer ce test — c'est le but, la sonde est publique.
  expect(body).toEqual({ status: "ok" });
  expect(Object.keys(body)).toHaveLength(1);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
});
