// src/gateway/protocol.ts — construction du payload canonique v3 signé pour
// l'auth "device identity" du gateway OpenClaw. Format et algorithme
// reverse-engineerés depuis le bundle officiel (dist/client-C8-EgcVB.js) et
// validés empiriquement contre une gateway réelle.

function normalize(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : "";
}

export interface DeviceAuthPayloadV3Params {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
  platform: string;
  deviceFamily: string;
}

export function buildDeviceAuthPayloadV3(p: DeviceAuthPayloadV3Params): string {
  return [
    "v3",
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(","),
    String(p.signedAtMs),
    p.token,
    p.nonce,
    normalize(p.platform),
    normalize(p.deviceFamily),
  ].join("|");
}
