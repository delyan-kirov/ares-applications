// The playground page: one editor per tour cell, all backed by a single
// instance of the compiler wasm. Running a cell compiles it and shows what it
// printed on the output card; editing one is served by the language server
// inside the same wasm.

import { createHost, Mode } from "./host.ts";
import { Client } from "./lsp.ts";
import { Editor } from "./editor.ts";
import { showOutput } from "./card.ts";

/// A tour cell, as web/build.ts writes it from web/cells/*.ares.
interface Cell { id: string; title: string; blurb: string; src: string }

/// How many cells the language server keeps checked at once. Each holds its
/// whole import closure, `CORE` included, so the least recently used one is
/// closed past this.
const OPEN_LIMIT = 3;

const host = createHost();

/// Inline formatting for prose: escape HTML, then `code` -> <code>.
function fmt(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/`([^`]+)`/g, "<code>$1</code>");
}

const boot = document.getElementById("boot") as HTMLElement;

let cells: Cell[];
try {
  const [wasm, list] = await Promise.all([fetch("playground.wasm"), fetch("cells.json")]);
  cells = await list.json() as Cell[];
  const { instance } = await WebAssembly.instantiate(await wasm.arrayBuffer(), host.imports);
  host.bind(instance.exports);
} catch (e) {
  boot.innerHTML =
    "The Ares compiler failed to load. Serve this page over http:// after building it " +
    "(<code>node web/build.ts</code> from the applications workspace).";
  throw e;
}

const client = new Client(host);

interface Runner {
  editor: Editor;
  check: HTMLElement;
  id: string;
  title: string;
  src: string;
}

/// Documents open on the server, most recently used last.
const recent: Runner[] = [];
const byUri = new Map<string, Runner>();

function activate(r: Runner): void {
  const at = recent.indexOf(r);
  if (at >= 0) recent.splice(at, 1);
  recent.push(r);
  if (!client.isOpen(r.editor.uri)) client.open(r.editor.uri, r.editor.text);
  while (recent.length > OPEN_LIMIT) {
    const old = recent.shift() as Runner;
    client.close(old.editor.uri);
  }
}

client.onDiagnostics = (uri, version, diagnostics) => {
  const r = byUri.get(uri);
  if (!r) return;
  r.editor.setDiagnostics(version, diagnostics);
  showCheck(r);
};

function showCheck(r: Runner): void {
  const n = r.editor.errorCount();
  r.check.textContent = n === null ? "" : n === 0 ? "✓ checks" : `${n} error${n === 1 ? "" : "s"}`;
  r.check.className = "check" + (n === null ? "" : n === 0 ? " ok" : " bad");
}

function run(r: Runner): void {
  let text: string;
  let failed: boolean;
  try {
    text = host.compile(r.editor.text, Mode.Run);
    failed = /error|mismatch|unbound|cannot|fault|unavailable/i.test(text.split("\n")[0]) && !/^exit -?\d+$/m.test(text);
  } catch (e) {
    text = `the compiler trapped: ${e} (reload the page)`;
    failed = true;
  }
  showOutput(r.id, { title: r.title, text, failed });
}

const notebook = document.getElementById("notebook") as HTMLElement;
cells.forEach((cell, i) => {
  const sec = document.createElement("section");
  sec.className = "cell";
  sec.innerHTML = `
    <div class="prose">
      <h2><span class="n">${String(i + 1).padStart(2, "0")}</span>${fmt(cell.title)}</h2>
      <p>${fmt(cell.blurb)}</p>
    </div>
    <div class="pane">
      <div class="bar">
        <span class="label">program</span>
        <span class="check"></span>
        <span class="spacer"></span>
        <button class="fmt" title="format with the compiler's formatter">Format</button>
        <button class="reset" title="reset this program to the original">Reset</button>
        <button class="run" title="run (Ctrl/&#8984; + Enter)">&#9654; Run</button>
      </div>
    </div>`;
  notebook.appendChild(sec);
  const pane = sec.querySelector(".pane") as HTMLElement;
  const r = {
    check: sec.querySelector(".check") as HTMLElement,
    id: cell.id,
    title: `${String(i + 1).padStart(2, "0")}  ${cell.title.replace(/`/g, "")}`,
    src: cell.src,
  } as Runner;
  r.editor = new Editor(pane, {
    client,
    uri: `file:///playground/${cell.id}.ares`,
    text: cell.src,
    activate: () => activate(r),
  });
  byUri.set(r.editor.uri, r);
  (sec.querySelector(".run") as HTMLButtonElement).onclick = () => run(r);
  (sec.querySelector(".fmt") as HTMLButtonElement).onclick = () => r.editor.format();
  (sec.querySelector(".reset") as HTMLButtonElement).onclick = () => r.editor.setText(r.src);
  r.editor.input.addEventListener("input", () => showCheck(r));
  r.editor.input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(r); }
  });
});

boot.innerHTML =
  "Ready. This page is powered by the Ares compiler running as WebAssembly in your " +
  "browser, language server included: the colors, squiggles, hovers and completions " +
  "come from it. <a href=\"https://github.com/delyan-kirov/Ares\">Read the source</a>.";
