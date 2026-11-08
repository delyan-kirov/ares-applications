// Build the site and verify it, in one command:
//
//   node web/build.ts          (from the applications workspace, in the web shell)
//
// 1. the compiler and its language server to wasm (site/playground.wasm),
// 2. the site icon, by compiling and running FAVICON.ares with the native
//    compiler from the enclosing tree (site/favicon.svg, favicon.png and
//    apple-touch-icon.png),
// 3. the tour cells, web/cells/*.ares, to site/cells.json,
// 4. the page's TypeScript, web/src/*.ts, to site/*.js with tsc,
// 5. the smoke test, which runs every cell and drives the language server.
//
// `site/playground.wasm` is a checked-in binary, so it does not follow the
// compiler the way the rest of the tree does: rebuild after every change to
// crates/ or library/.
//
// Needs `wasm-ld`, `tsc` and `ffmpeg` on PATH, which the web dev shell supplies.

import { spawnSync } from "node:child_process";
import { copyFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readCells } from "./cells.ts";

const web = fileURLToPath(new URL(".", import.meta.url));
const workspace = fileURLToPath(new URL("..", import.meta.url));
const compiler = fileURLToPath(new URL("../..", import.meta.url));
const built = `${workspace}target/wasm32-unknown-unknown/release/playground.wasm`;
const shipped = `${web}site/playground.wasm`;

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const { status, error } = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    console.error(`\n${cmd} is not on PATH. Enter the web dev shell first:\n    nix develop ./web\n`);
    process.exit(1);
  }
  if (status !== 0) process.exit(status ?? 1);
}

run("cargo", ["build", "-p", "playground", "--target", "wasm32-unknown-unknown", "--release"], workspace);
copyFileSync(built, shipped);
console.log(`+ site/playground.wasm  (${(statSync(shipped).size / 1024).toFixed(0)} KiB)`);

run("cargo", ["build", "-p", "ares", "--release"], compiler);
run(`${compiler}target/release/ares`, ["build", "FAVICON.ares"], web);
run(`${web}ares-out/FAVICON`, [], web);

const cells = readCells();
writeFileSync(`${web}site/cells.json`, JSON.stringify(cells, null, 1) + "\n");
console.log(`+ site/cells.json  (${cells.length} cells)`);

run("tsc", ["-p", "tsconfig.json"], web);

run("node", ["smoke.ts"], web);
