import { describe, expect, test } from "bun:test";
import { isAllowedBindHost, parseEnv } from "./env";

type Source = Record<string, string | undefined>;

// Source minimale valide ; les tests écrasent le champ qu'ils éprouvent.
function baseSource(overrides: Source = {}): Source {
  return {
    AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
    GATEWAY_AUTH_TOKEN: "gateway-secret-token",
    GATEWAY_URL: "http://127.0.0.1:8080",
    ...overrides,
  };
}

describe("parseEnv", () => {
  test("accepte une configuration complète et valide", () => {
    const env = parseEnv({
      PORT: "3001",
      BIND_HOST: "127.0.0.1",
      AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
      GATEWAY_URL: "http://127.0.0.1:8080",
      GATEWAY_AUTH_TOKEN: "gateway-secret-token",
      OLLAMA_URL: "http://127.0.0.1:11434",
      OLLAMA_FALLBACK_MODEL: "qwen3.5:9b",
      ORANGE_GATEWAY_IP: "192.168.1.1",
      DB_PATH: "./data/clawdeck.sqlite",
      GATEWAY_DEVICE_IDENTITY_PATH: "./data/gateway-device-identity.json",
    });
    expect(env).toEqual({
      port: 3001,
      bindHost: "127.0.0.1",
      authToken: "0123456789abcdef0123456789abcdef",
      gatewayUrl: "http://127.0.0.1:8080",
      gatewayWsUrl: "ws://127.0.0.1:8080/",
      gatewayAuthToken: "gateway-secret-token",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaFallbackModel: "qwen3.5:9b",
      orangeGatewayIp: "192.168.1.1",
      dbPath: "./data/clawdeck.sqlite",
      gatewayDeviceIdentityPath: "./data/gateway-device-identity.json",
    });
  });

  test("applique les valeurs par défaut quand les variables optionnelles manquent", () => {
    const env = parseEnv(baseSource());
    expect(env.port).toBe(3001);
    expect(env.bindHost).toBe("127.0.0.1");
    expect(env.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(env.ollamaFallbackModel).toBe("qwen3.5:9b");
    expect(env.orangeGatewayIp).toBeNull();
    expect(env.dbPath).toBe("./data/clawdeck.sqlite");
    expect(env.gatewayDeviceIdentityPath).toBe(
      "./data/gateway-device-identity.json",
    );
  });

  test("dérive gatewayWsUrl depuis GATEWAY_URL", () => {
    expect(
      parseEnv(baseSource({ GATEWAY_URL: "http://127.0.0.1:8080" })).gatewayWsUrl,
    ).toBe("ws://127.0.0.1:8080/");
    expect(
      parseEnv(baseSource({ GATEWAY_URL: "https://gw.example" })).gatewayWsUrl,
    ).toBe("wss://gw.example/");
  });

  test("rejette un PORT non numérique", () => {
    expect(() => parseEnv(baseSource({ PORT: "abc" }))).toThrow(/PORT/);
  });

  test("rejette un PORT hors plage (0)", () => {
    expect(() => parseEnv(baseSource({ PORT: "0" }))).toThrow(/PORT/);
  });

  test("rejette un PORT hors plage (70000)", () => {
    expect(() => parseEnv(baseSource({ PORT: "70000" }))).toThrow(/PORT/);
  });

  test("exige AUTH_TOKEN", () => {
    expect(() => parseEnv(baseSource({ AUTH_TOKEN: undefined }))).toThrow(
      /AUTH_TOKEN/,
    );
  });

  test("refuse la valeur d'exemple AUTH_TOKEN=change-me", () => {
    expect(() => parseEnv(baseSource({ AUTH_TOKEN: "change-me" }))).toThrow(
      /AUTH_TOKEN/,
    );
  });

  test("refuse un AUTH_TOKEN trop court", () => {
    expect(() => parseEnv(baseSource({ AUTH_TOKEN: "trop-court" }))).toThrow(
      /16/,
    );
  });

  test("ne divulgue jamais la valeur d'AUTH_TOKEN dans le message d'erreur", () => {
    const provided = "TOKEN_SECRET_42"; // 15 caractères → trop court
    expect(provided.length).toBeLessThan(16);
    expect(() => parseEnv(baseSource({ AUTH_TOKEN: provided }))).toThrow();
    try {
      parseEnv(baseSource({ AUTH_TOKEN: provided }));
    } catch (error) {
      expect((error as Error).message).not.toContain(provided);
    }
  });

  test("refuse la valeur d'exemple GATEWAY_AUTH_TOKEN=change-me", () => {
    expect(() =>
      parseEnv(baseSource({ GATEWAY_AUTH_TOKEN: "change-me" })),
    ).toThrow(/GATEWAY_AUTH_TOKEN/);
  });

  test("rejette une GATEWAY_URL de schéma non http(s)", () => {
    expect(() => parseEnv(baseSource({ GATEWAY_URL: "ftp://gw" }))).toThrow(
      /GATEWAY_URL/,
    );
  });

  test("rejette une GATEWAY_URL non parsable", () => {
    expect(() => parseEnv(baseSource({ GATEWAY_URL: "pas une url" }))).toThrow(
      /GATEWAY_URL/,
    );
  });

  test("rejette une OLLAMA_URL invalide", () => {
    expect(() => parseEnv(baseSource({ OLLAMA_URL: "ftp://ollama" }))).toThrow(
      /OLLAMA_URL/,
    );
  });

  test("accepte les BIND_HOST loopback et Tailscale", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "::1",
      "100.66.217.18",
      "fd7a:115c:a1e0::1",
    ]) {
      expect(parseEnv(baseSource({ BIND_HOST: host })).bindHost).toBe(host);
    }
  });

  test("refuse les BIND_HOST hors allowlist", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "exemple.com"]) {
      expect(() => parseEnv(baseSource({ BIND_HOST: host }))).toThrow(
        /BIND_HOST/,
      );
    }
  });

  test("traduit une ORANGE_GATEWAY_IP vide en null", () => {
    expect(
      parseEnv(baseSource({ ORANGE_GATEWAY_IP: "" })).orangeGatewayIp,
    ).toBeNull();
  });

  test("rejette une ORANGE_GATEWAY_IP mal formée", () => {
    expect(() =>
      parseEnv(baseSource({ ORANGE_GATEWAY_IP: "999.1.1.1" })),
    ).toThrow(/ORANGE_GATEWAY_IP/);
  });

  test("rejette un DB_PATH vide après trim", () => {
    expect(() => parseEnv(baseSource({ DB_PATH: "   " }))).toThrow(/DB_PATH/);
  });
});

describe("isAllowedBindHost", () => {
  test("bornes basses de la plage Tailscale 100.64.0.0/10", () => {
    expect(isAllowedBindHost("100.63.255.255")).toBe(false);
    expect(isAllowedBindHost("100.64.0.0")).toBe(true);
  });

  test("bornes hautes de la plage Tailscale 100.64.0.0/10", () => {
    expect(isAllowedBindHost("100.127.255.255")).toBe(true);
    expect(isAllowedBindHost("100.128.0.0")).toBe(false);
  });

  test("accepte le loopback et les adresses Tailscale", () => {
    expect(isAllowedBindHost("127.0.0.1")).toBe(true);
    expect(isAllowedBindHost("127.0.0.53")).toBe(true);
    expect(isAllowedBindHost("localhost")).toBe(true);
    expect(isAllowedBindHost("::1")).toBe(true);
    expect(isAllowedBindHost("fd7a:115c:a1e0::1")).toBe(true);
    expect(isAllowedBindHost("fd7a:115c:a1e0:ab12:4843:cd96:1234:5678")).toBe(
      true,
    );
  });

  test("refuse les wildcards, IP LAN et noms d'hôte", () => {
    expect(isAllowedBindHost("0.0.0.0")).toBe(false);
    expect(isAllowedBindHost("::")).toBe(false);
    expect(isAllowedBindHost("192.168.1.10")).toBe(false);
    expect(isAllowedBindHost("10.0.0.1")).toBe(false);
    expect(isAllowedBindHost("exemple.com")).toBe(false);
    expect(isAllowedBindHost("")).toBe(false);
  });
});
