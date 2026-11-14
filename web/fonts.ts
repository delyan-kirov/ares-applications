// The site's typefaces, subset to woff2 in site/fonts/ from the nix packages
// the web dev shell points ARES_FONT_* at (see flake.nix). Run by build.ts, or
// alone:
//
//   node web/fonts.ts

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("./site/fonts", import.meta.url));

function fontDir(name: string): string {
  const dir = process.env[name];
  if (!dir) {
    console.error(`\n${name} is not set. Enter the web dev shell first:\n    nix develop ./web\n`);
    process.exit(1);
  }
  return dir;
}

// [output name, source directory variable, file]. Latin, punctuation, arrows
// and the few symbols the page uses; every face keeps its OpenType features.
const FONTS: [string, string, string][] = [
  ["cinzel-bold", "ARES_FONT_CINZEL", "Cinzel-Bold.ttf"],
  ["serif", "ARES_FONT_SERIF", "SourceSerif4-Regular.otf"],
  ["serif-italic", "ARES_FONT_SERIF", "SourceSerif4-It.otf"],
  ["serif-semibold", "ARES_FONT_SERIF", "SourceSerif4-Semibold.otf"],
  ["mono", "ARES_FONT_MONO", "Go-Mono.ttf"],
  ["mono-bold", "ARES_FONT_MONO", "Go-Mono-Bold.ttf"],
  ["mono-italic", "ARES_FONT_MONO", "Go-Mono-Italic.ttf"],
];
const UNICODES = "U+0000-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2190-21FF,U+2200-22FF,U+2318,U+25B6,U+2713,U+29BD";

export function buildFonts(): void {
  mkdirSync(out, { recursive: true });
  for (const [name, dir, file] of FONTS) {
    const args = [
      "-m", "fontTools.subset", `${fontDir(dir)}/${file}`,
      `--unicodes=${UNICODES}`, "--flavor=woff2", "--layout-features=*",
      `--output-file=${out}/${name}.woff2`,
    ];
    const { status } = spawnSync("python3", args, { stdio: "inherit" });
    if (status !== 0) process.exit(status ?? 1);
  }
  // Cinzel and Source Serif 4 are under the SIL Open Font License, Go Mono under
  // the Go BSD license, which the site ships beside the files.
  // Files in the nix store are read-only, and so is a copy, which the next
  // build could not overwrite.
  copyFileSync(fontDir("ARES_FONT_MONO_LICENSE"), `${out}/LICENSE-go-mono.txt`);
  chmodSync(`${out}/LICENSE-go-mono.txt`, 0o644);
  writeFileSync(`${out}/README.txt`,
    "Cinzel (Natanael Gama) and Source Serif 4 (Adobe): SIL Open Font License 1.1,\n" +
    "https://openfontlicense.org. Go Mono (Bigelow & Holmes): see LICENSE-go-mono.txt.\n");
  console.log(`+ site/fonts/  (${FONTS.length} faces)`);
}

if (import.meta.url === `file://${process.argv[1]}`) buildFonts();
