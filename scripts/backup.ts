// scripts/backup.ts — sauvegarde des deux seuls états non reproductibles.
//
//   bun scripts/backup.ts [dossier-de-destination]
//
// Ce qui est sauvegardé, et pourquoi seulement ça :
//
//  - `data/gateway-device-identity.json` — la clé Ed25519 qui identifie
//    clawdeck auprès de la gateway OpenClaw. La perdre ne casse rien
//    d'irréversible, mais la gateway traite alors clawdeck comme un APPAREIL
//    NOUVEAU : il faut le ré-appairer, et l'ancienne identité traîne dans la
//    liste des appareils.
//  - `data/clawdeck.sqlite` — l'historique des pings (7 jours glissants). Seule
//    donnée que clawdeck persiste ; tout le reste se relit depuis OpenClaw.
//
// `.env` n'est PAS inclus : il contient les deux secrets du déploiement. Le
// mettre dans une archive qu'on déplace ferait voyager les secrets à chaque
// sauvegarde. À conserver séparément par l'opérateur (voir README).
//
// La base est copiée par `VACUUM INTO` et non par une copie de fichier : le
// serveur tourne en journalisation WAL, et copier le seul `.sqlite` pendant
// qu'il écrit produit une archive éventuellement incohérente (transactions
// présentes dans le WAL et absentes du fichier principal).

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getEnv } from "../src/env";

// 0600 : lisible et modifiable par le seul propriétaire. L'identité est une
// clé privée, l'archive la contient.
const OWNER_ONLY = 0o600;

function horodatage(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  const env = getEnv();
  const destination = resolve(process.argv[2] ?? join(process.cwd(), "sauvegardes"));
  mkdirSync(destination, { recursive: true });

  const staging = mkdtempSync(join(tmpdir(), "clawdeck-sauvegarde-"));
  const inclus: string[] = [];

  try {
    // Identité : simple copie, le fichier est écrit une fois puis relu.
    if (existsSync(env.gatewayDeviceIdentityPath)) {
      const cible = join(staging, "gateway-device-identity.json");
      copyFileSync(env.gatewayDeviceIdentityPath, cible);
      chmodSync(cible, OWNER_ONLY);
      inclus.push("identité gateway");
    } else {
      console.warn("identité gateway absente : elle sera recréée au prochain démarrage");
    }

    // Base : snapshot cohérent même serveur en marche. Ouverture en lecture
    // seule pour ne rien pouvoir altérer depuis un outil de sauvegarde.
    if (existsSync(env.dbPath)) {
      const cible = join(staging, "clawdeck.sqlite");
      const source = new Database(env.dbPath, { readonly: true });
      try {
        source.exec(`VACUUM INTO '${cible.replace(/'/g, "''")}'`);
      } finally {
        source.close();
      }
      chmodSync(cible, OWNER_ONLY);
      inclus.push("historique des pings");
    } else {
      console.warn("base absente : aucun historique de pings à sauvegarder");
    }

    if (inclus.length === 0) {
      console.error("rien à sauvegarder");
      process.exitCode = 1;
      return;
    }

    const archive = join(destination, `clawdeck-${horodatage()}.tar.gz`);
    const tar = Bun.spawn(["tar", "-czf", archive, "-C", staging, "."], { stdout: "ignore", stderr: "pipe" });
    const code = await tar.exited;
    if (code !== 0) {
      console.error(`échec de l'archivage : ${await new Response(tar.stderr).text()}`);
      process.exitCode = 1;
      return;
    }
    chmodSync(archive, OWNER_ONLY);

    // Vérification : une archive illisible découverte le jour de la
    // restauration n'est pas une sauvegarde.
    const verif = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "ignore" });
    const contenu = (await new Response(verif.stdout).text()).trim().split("\n").filter(Boolean);
    if ((await verif.exited) !== 0 || contenu.length === 0) {
      console.error("archive illisible après écriture");
      process.exitCode = 1;
      return;
    }

    const taille = statSync(archive).size;
    console.log(`écrit  ${archive}  (${(taille / 1024).toFixed(1)} Ko, permissions 0600)`);
    console.log(`inclus : ${inclus.join(", ")}`);
    console.log("rappel : .env n'est PAS inclus, le conserver séparément.");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

await main();
