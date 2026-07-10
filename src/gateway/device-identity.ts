// src/gateway/device-identity.ts — identité d'appareil Ed25519 pour l'auth
// gateway OpenClaw (device-signed connect, cf. docs/gateway/protocol.md).
// Persistée localement pour ne pas re-générer une identité (et re-déclencher
// un pairing) à chaque redémarrage du backend.

import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function publicKeyWireFormat(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

interface StoredIdentityV1 {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

export function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as StoredIdentityV1;
    if (stored.deviceId === fingerprintPublicKey(stored.publicKeyPem)) {
      return stored;
    }
  } catch {
    // pas de fichier, ou invalide : on en génère un nouveau ci-dessous
  }

  const identity = generateIdentity();
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const stored: StoredIdentityV1 = { version: 1, ...identity, createdAtMs: Date.now() };
  writeFileSync(filePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return identity;
}
