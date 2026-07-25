import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MEDIA_BYTES, MediaReadError, resolveMediaPath, safeMediaType } from "./media";

const racine = mkdtempSync(join(tmpdir(), "clawdeck-media-"));
const dehors = mkdtempSync(join(tmpdir(), "clawdeck-dehors-"));
afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
  rmSync(dehors, { recursive: true, force: true });
});

mkdirSync(join(racine, "media", "inbound"), { recursive: true });
const media = join(racine, "media", "inbound", "voix.ogg");
writeFileSync(media, "contenu");
const secret = join(dehors, "secret.txt");
writeFileSync(secret, "ne doit pas sortir");
// Symlink DANS le workspace pointant DEHORS : le piège que la comparaison sur
// chemin résolu doit attraper.
const piege = join(racine, "media", "evasion.txt");
try {
  symlinkSync(secret, piege);
} catch {
  // certains environnements interdisent les symlinks : le test ci-dessous
  // reste valide, il vérifiera simplement un « introuvable »
}

function attendreCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaReadError);
    expect((error as MediaReadError).code).toBe(code as never);
    return;
  }
  throw new Error(`aucune erreur levée, ${code} attendu`);
}

describe("resolveMediaPath", () => {
  test("accepte un média réellement sous la racine", () => {
    expect(resolveMediaPath(racine, media)).toBe(resolveMediaPath(racine, media));
    expect(resolveMediaPath(racine, media)).toContain("voix.ogg");
  });

  test("refuse un chemin hors du workspace", () => {
    attendreCode(() => resolveMediaPath(racine, secret), "outside-workspace");
  });

  test("refuse une traversée par « .. »", () => {
    attendreCode(() => resolveMediaPath(racine, join(racine, "..", "etc-passwd")), "not-found");
  });

  test("refuse un symlink d'évasion, malgré un chemin apparemment interne", () => {
    // Le chemin DEMANDÉ est sous la racine ; seul son realpath révèle la
    // sortie. C'est exactement ce qu'une comparaison de chaînes raterait.
    attendreCode(() => resolveMediaPath(racine, piege), "outside-workspace");
  });

  test("refuse une racine voisine dont le nom partage le préfixe", () => {
    // « /w/media-secret » ne doit pas passer la garde d'une racine « /w/media ».
    const voisin = `${racine}-voisin`;
    mkdirSync(voisin, { recursive: true });
    const fichier = join(voisin, "x.png");
    writeFileSync(fichier, "x");
    try {
      attendreCode(() => resolveMediaPath(racine, fichier), "outside-workspace");
    } finally {
      rmSync(voisin, { recursive: true, force: true });
    }
  });

  test("refuse un chemin vide ou porteur d'un octet nul", () => {
    attendreCode(() => resolveMediaPath(racine, ""), "invalid-path");
    attendreCode(() => resolveMediaPath(racine, `${media}\0.png`), "invalid-path");
  });

  test("refuse un dossier", () => {
    attendreCode(() => resolveMediaPath(racine, join(racine, "media")), "not-found");
  });

  test("refuse un fichier au-delà de la borne", () => {
    const gros = join(racine, "media", "gros.bin");
    writeFileSync(gros, Buffer.alloc(MAX_MEDIA_BYTES + 1));
    try {
      attendreCode(() => resolveMediaPath(racine, gros), "too-large");
    } finally {
      rmSync(gros, { force: true });
    }
  });
});

describe("safeMediaType", () => {
  test("normalise le type déclaré par OpenClaw", () => {
    // Forme réelle observée dans les transcripts.
    expect(safeMediaType("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(safeMediaType("IMAGE/PNG")).toBe("image/png");
  });

  test("neutralise tout type non prévu", () => {
    // Servir un type arbitraire, c'est offrir au navigateur un vecteur de
    // rendu que rien n'a validé.
    expect(safeMediaType("text/html")).toBe("application/octet-stream");
    expect(safeMediaType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeMediaType(null)).toBe("application/octet-stream");
    expect(safeMediaType(undefined)).toBe("application/octet-stream");
    expect(safeMediaType("")).toBe("application/octet-stream");
  });
});
