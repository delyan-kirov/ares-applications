// The tour cells are Ares programs, one file each in web/cells/, read in name
// order. A file's leading comment is its card: the first line is the title,
// the rest the blurb. The program shown starts at `$ @mod`.

import { readdirSync, readFileSync } from "node:fs";

export interface Cell { id: string; title: string; blurb: string; src: string }

export function readCells(): Cell[] {
  const dir = new URL("./cells/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ares"))
    .sort()
    .map((file) => {
      const lines = readFileSync(new URL(file, dir), "utf8").split("\n");
      const header: string[] = [];
      while (lines.length && lines[0].startsWith("#")) header.push((lines.shift() as string).replace(/^# ?/, ""));
      while (lines.length && lines[0].trim() === "") lines.shift();
      const src = lines.join("\n");
      if (header.length === 0 || !src.startsWith("$ @mod")) {
        throw new Error(`cells/${file}: expected a "# Title" comment, then the program from "$ @mod"`);
      }
      const blurb = header.slice(1).join("\n").trim().split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ")).join("\n\n");
      return { id: file.replace(/^\d+-/, "").replace(/\.ares$/, ""), title: header[0], blurb, src };
    });
}
