// Build the site and verify it, in one command:
//
//   node web/build.ts          (from the applications workspace, in the web shell)
//
// 1. the compiler and its language server to wasm (site/playground.wasm),
// 2. the site icon and the background's spear sprites, by compiling and
//    running the generator tools/LOGO.ares with the native compiler from the
//    enclosing tree (site/favicon.svg, favicon.png, apple-touch-icon.png,
//    spear.png and spear-shield.png),
// 3. the typefaces, subset to woff2 in site/fonts/ from the nix packages the
//    web shell points ARES_FONT_* at,
// 4. the tour cells, web/cells/*.ares, to site/cells.json,
// 5. the page's TypeScript, web/src/*.ts, to site/*.js with tsc,
// 6. the smoke test, which runs every cell and drives the language server.
//
// `site/playground.wasm` is a checked-in binary, so it does not follow the
// compiler the way the rest of the tree does: rebuild after every change to
// crates/ or library/.
//
// Needs `wasm-ld`, `tsc`, `ffmpeg` and a `python3` with fontTools on PATH, and
// the ARES_FONT_* variables, all of which the web dev shell supplies.

import { spawnSync } from "node:child_process";
import { copyFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readCells } from "./cells.ts";
import { buildFonts } from "./fonts.ts";

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
run(`${compiler}target/release/ares`, ["build", "tools/LOGO.ares"], compiler);
run(`${compiler}tools/ares-out/LOGO`, [
  "logo",
  `${web}site/favicon.svg`,
  `${web}site/favicon.png`, "32",
  `${web}site/apple-touch-icon.png`, "180",
], compiler);
// 512 px covers the nearest spear (about 230 CSS px long) on a 2x display.
for (const sprite of ["spear", "spear-shield"]) {
  run(`${compiler}tools/ares-out/LOGO`, [sprite, `${web}site/${sprite}.svg`, `${web}site/${sprite}.png`, "512"], compiler);
}

buildFonts();

const cells = readCells();
writeFileSync(`${web}site/cells.json`, JSON.stringify(cells, null, 1) + "\n");
console.log(`+ site/cells.json  (${cells.length} cells)`);

run("tsc", ["-p", "tsconfig.json"], web);

run("node", ["smoke.ts"], web);
