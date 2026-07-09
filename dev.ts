#!/usr/bin/env bun
// dev.ts — lance backend (Hono, --watch) et front (Vite) en parallèle.
// `bun run dev` à la racine.

const backend = Bun.spawn({
  cmd: ["bun", "--watch", "src/index.ts"],
  cwd: import.meta.dir,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

const frontend = Bun.spawn({
  cmd: ["bun", "run", "dev"],
  cwd: `${import.meta.dir}/web`,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.kill();
  frontend.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([backend.exited, frontend.exited]);
shutdown();
