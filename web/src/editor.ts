// A code editor with no dependencies: a transparent <textarea> (which keeps
// native editing, selection, undo and IME) laid exactly over a <pre> that shows
// the same text colored by the language server's semantic tokens and underlined
// by its diagnostics. Both have one font, width, padding, tab size and wrapping
// rule, so a character lands in the same place in each. Neither scrolls: long
// lines wrap and the editor grows to fit. Where a character is drawn is read
// off the <pre> with DOM ranges, which wrapping does not disturb.

import type { Client, CodeAction, CompletionItem, Diagnostic, Position, TextEdit } from "./lsp.ts";

const TAB = 4;
const INDENT = " ".repeat(TAB);

/// A text's line starts, for converting LSP positions (UTF-16, which is what a
/// JS string indexes) to offsets and back.
class Lines {
  readonly starts: number[] = [0];
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  offset(p: Position): number {
    const start = this.starts[Math.min(p.line, this.starts.length - 1)];
    return Math.min(start + p.character, this.end(p.line));
  }
  position(offset: number): Position {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo] };
  }
  /// The offset of line `n`'s end, before its newline.
  end(n: number): number {
    return n + 1 < this.starts.length ? this.starts[n + 1] - 1 : this.text.length;
  }
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = new Lines(text);
  const spans = edits
    .map((e) => ({ start: lines.offset(e.range.start), end: lines.offset(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start);
  for (const s of spans) text = text.slice(0, s.start) + s.text + text.slice(s.end);
  return text;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SEVERITY = ["", "error", "warning", "info", "hint"];

export interface EditorOptions {
  client: Client;
  uri: string;
  text: string;
  /// The editor is about to need the server (it was focused, edited or
  /// hovered): open its document if it is not.
  activate(editor: Editor): void;
}

interface Mark { start: number; end: number; cls: string }

/// The one floating panel (hover or completion) on the page at a time.
/// `closed` tells its editor, whatever closed it.
let floating: { el: HTMLElement; owner: Editor; closed?: () => void } | null = null;

function closeFloating(): void {
  const f = floating;
  floating = null;
  f?.el.remove();
  f?.closed?.();
}

export class Editor {
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private view: HTMLPreElement;
  private problems: HTMLElement;
  private client: Client;
  readonly uri: string;
  private activate: (editor: Editor) => void;
  private diagnostics: Diagnostic[] = [];
  private diagnosticsVersion = -1;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverAt = -1;
  private completion: { items: CompletionItem[]; selected: number; start: number; el: HTMLElement } | null = null;

  constructor(parent: HTMLElement, options: EditorOptions) {
    this.client = options.client;
    this.uri = options.uri;
    this.activate = options.activate;

    this.root = document.createElement("div");
    this.root.className = "ed";
    this.root.innerHTML = `
      <div class="ed-inner">
        <pre class="ed-view" aria-hidden="true"></pre>
        <textarea class="ed-input" spellcheck="false" autocapitalize="off" autocomplete="off"
          autocorrect="off" aria-label="Ares program"></textarea>
      </div>
      <ul class="ed-problems"></ul>`;
    parent.appendChild(this.root);
    this.view = this.root.querySelector(".ed-view") as HTMLPreElement;
    this.input = this.root.querySelector(".ed-input") as HTMLTextAreaElement;
    this.problems = this.root.querySelector(".ed-problems") as HTMLElement;
    this.input.value = options.text;

    this.input.addEventListener("input", (e) => this.changed(e as InputEvent));
    this.input.addEventListener("keydown", (e) => this.keydown(e));
    this.input.addEventListener("focus", () => this.activate(this));
    this.input.addEventListener("blur", () => this.closeCompletion());
    this.input.addEventListener("mousemove", (e) => this.pointer(e));
    this.input.addEventListener("mouseleave", () => this.leave());
    this.input.addEventListener("scroll", () => { this.input.scrollTop = 0; });
    this.render();
  }

  get text(): string { return this.input.value; }

  /// Replace the whole text the way typing would, so it can be undone.
  setText(text: string): void {
    this.replace(0, this.text.length, text);
  }

  setDiagnostics(version: number, diagnostics: Diagnostic[]): void {
    this.diagnostics = diagnostics;
    this.diagnosticsVersion = version;
    this.render();
  }

  /// Diagnostics for the text as it stands; none while a check is pending.
  private current(): Diagnostic[] {
    if (this.diagnosticsVersion !== this.client.version(this.uri)) return [];
    return this.diagnostics.filter((d) => d.data?.role !== "grace");
  }

  /// How many errors the last check found, or null while one is pending.
  errorCount(): number | null {
    if (!this.client.isOpen(this.uri) || this.diagnosticsVersion !== this.client.version(this.uri)) return null;
    return this.current().filter((d) => d.severity === 1).length;
  }

  // -- drawing ------------------------------------------------------------

  private render(): void {
    const text = this.text;
    const lines = new Lines(text);
    const marks: Mark[] = [];

    const data = this.client.highlight(text);
    const types = this.client.tokenTypes;
    let line = 0, ch = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      if (data[i] > 0) { line += data[i]; ch = data[i + 1]; } else ch += data[i + 1];
      const start = lines.offset({ line, character: ch });
      marks.push({ start, end: start + data[i + 2], cls: "t-" + (types[data[i + 3]] ?? "x") });
    }

    const diagnostics = this.current();
    for (const d of diagnostics) {
      let start = lines.offset(d.range.start), end = lines.offset(d.range.end);
      if (end <= start) {
        // An empty span marks a place (a missing token): underline one character.
        if (start >= text.length) start = Math.max(0, text.length - 1);
        end = start + 1;
      }
      const role = d.data?.role === "focus" ? " d-focus" : "";
      marks.push({ start, end, cls: `d d-${SEVERITY[d.severity ?? 1]}${role}` });
    }

    const points = new Set<number>([0, text.length]);
    for (const m of marks) { points.add(Math.min(m.start, text.length)); points.add(Math.min(m.end, text.length)); }
    const cuts = [...points].sort((a, b) => a - b);
    let html = "";
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      const cls = marks.filter((m) => m.start <= a && b <= m.end).map((m) => m.cls).join(" ");
      const piece = escape(text.slice(a, b));
      html += cls ? `<span class="${cls}">${piece}</span>` : piece;
    }
    // A <pre> drops a final newline that the textarea shows as an empty line.
    this.view.innerHTML = html + (text.endsWith("\n") || text === "" ? " " : "");
    this.renderProblems(diagnostics, lines);
  }

  private renderProblems(diagnostics: Diagnostic[], lines: Lines): void {
    this.problems.textContent = "";
    for (const d of diagnostics) {
      if (d.severity === 4) continue;
      const li = document.createElement("li");
      li.className = `p-${SEVERITY[d.severity ?? 1]}` + (d.data?.role === "focus" ? " p-focus" : "");
      const at = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
      li.innerHTML = `<span class="p-at">${at}</span> ${escape(d.message.split("\n")[0])}`;
      li.title = d.message;
      li.onclick = () => {
        const start = lines.offset(d.range.start);
        this.input.focus();
        this.input.setSelectionRange(start, Math.max(start, lines.offset(d.range.end)));
      };
      this.problems.appendChild(li);
    }
  }

  // -- geometry -----------------------------------------------------------

  /// The text node of the view holding `offset`, and the offset within it.
  private locate(offset: number): [Text, number] | null {
    const walk = document.createTreeWalker(this.view, NodeFilter.SHOW_TEXT);
    let base = 0;
    for (let node = walk.nextNode() as Text | null; node; node = walk.nextNode() as Text | null) {
      const n = node.data.length;
      if (offset < base + n) return [node, offset - base];
      base += n;
    }
    return null;
  }

  /// The offset of the character under a pointer, or -1 off the text.
  private offsetAt(clientX: number, clientY: number): number {
    const inside = (r: DOMRect) => r.left <= clientX && clientX < r.right && r.top <= clientY && clientY < r.bottom;
    const walk = document.createTreeWalker(this.view, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let base = 0;
    for (let node = walk.nextNode() as Text | null; node; node = walk.nextNode() as Text | null) {
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some(inside)) {
        for (let i = 0; i < node.data.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          if (node.data[i] !== "\n" && [...range.getClientRects()].some(inside)) {
            return base + i < this.text.length ? base + i : -1;
          }
        }
      }
      base += node.data.length;
    }
    return -1;
  }

  /// Where the character at `offset` is drawn, in client coordinates.
  private pointOf(offset: number): { left: number; top: number; bottom: number } {
    const range = document.createRange();
    const at = this.locate(offset);
    if (at) {
      range.setStart(at[0], at[1]);
      range.collapse(true);
      const r = range.getBoundingClientRect();
      if (r.height > 0) return { left: r.left, top: r.top, bottom: r.bottom };
      if (at[1] + 1 <= at[0].data.length) {
        range.setEnd(at[0], at[1] + 1);
        const c = range.getBoundingClientRect();
        if (c.height > 0) return { left: c.left, top: c.top, bottom: c.bottom };
      }
    }
    const box = this.input.getBoundingClientRect();
    return { left: box.left, top: box.top, bottom: box.top };
  }

  private place(el: HTMLElement, at: { left: number; top: number; bottom: number }): void {
    document.body.appendChild(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(at.left, innerWidth - w - 8));
    const top = at.bottom + h + 4 > innerHeight ? at.top - h - 4 : at.bottom + 4;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(4, top)}px`;
  }

  // -- editing ------------------------------------------------------------

  private replace(start: number, end: number, text: string): void {
    this.input.focus();
    this.input.setSelectionRange(start, end);
    // `insertText` goes through the browser's editing path, so it is undoable
    // and fires `input` like typing does.
    if (!document.execCommand("insertText", false, text)) {
      this.input.setRangeText(text, start, end, "end");
      this.changed(null);
    }
  }

  private changed(e: InputEvent | null): void {
    if (this.client.isOpen(this.uri)) this.client.change(this.uri, this.text);
    else this.activate(this);
    this.render();
    closeFloatingOf(this, "tip");
    const typed = e?.inputType === "insertText" ? e.data ?? "" : "";
    if (/^[A-Za-z0-9_.?]$/.test(typed)) this.complete(false);
    else if (this.completion && e?.inputType === "deleteContentBackward") this.complete(false);
    else this.closeCompletion();
  }

  private keydown(e: KeyboardEvent): void {
    const c = this.completion;
    if (c) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = c.items.length;
        c.selected = (c.selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        this.drawCompletion();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.accept(c.items[c.selected]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeCompletion(); return; }
    }
    if (e.key === " " && e.ctrlKey) { e.preventDefault(); this.complete(true); return; }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.replace(this.input.selectionStart, this.input.selectionEnd, INDENT);
    }
    if (e.key === "Escape" && floating) {
      e.stopPropagation();
      closeFloating();
    }
  }

  // -- completion ---------------------------------------------------------

  private complete(explicit: boolean): void {
    this.activate(this);
    const caret = this.input.selectionEnd;
    const before = this.text.slice(0, caret);
    const word = /[A-Za-z0-9_?]*$/.exec(before)?.[0] ?? "";
    const afterDot = before.endsWith(".") || before.slice(0, caret - word.length).endsWith(".");
    if (!explicit && word === "" && !afterDot) { this.closeCompletion(); return; }
    const pos = new Lines(this.text).position(caret);
    const items = this.client.completion(this.uri, pos)
      .filter((it) => it.label !== word)
      .sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label))
      .slice(0, 50);
    if (items.length === 0) { this.closeCompletion(); return; }
    if (!this.completion) {
      const el = document.createElement("ul");
      el.className = "float complete";
      this.completion = { items, selected: 0, start: caret - word.length, el };
    } else {
      this.completion.items = items;
      this.completion.selected = 0;
      this.completion.start = caret - word.length;
    }
    this.drawCompletion();
  }

  private drawCompletion(): void {
    const c = this.completion;
    if (!c) return;
    c.el.innerHTML = c.items
      .map((it, i) => `<li class="${i === c.selected ? "sel" : ""}"><b>${escape(it.label)}</b>` +
        `<span>${escape(it.detail ?? "")}</span></li>`)
      .join("");
    c.el.querySelectorAll("li").forEach((li, i) => {
      li.addEventListener("mousedown", (e) => { e.preventDefault(); this.accept(c.items[i]); });
    });
    if (floating?.el !== c.el) {
      closeFloating();
      floating = { el: c.el, owner: this, closed: () => { this.completion = null; } };
      this.place(c.el, this.pointOf(c.start));
    }
    (c.el.querySelector(".sel") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }

  private accept(item: CompletionItem): void {
    const c = this.completion;
    if (!c) return;
    this.closeCompletion();
    this.replace(c.start, this.input.selectionEnd, item.label);
  }

  private closeCompletion(): void {
    if (this.completion && floating?.el === this.completion.el) closeFloating();
    this.completion = null;
  }

  // -- hover and fixes ----------------------------------------------------

  private pointer(e: MouseEvent): void {
    if (this.completion) return;
    const offset = this.offsetAt(e.clientX, e.clientY);
    if (offset === this.hoverAt) return;
    this.hoverAt = offset;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    closeFloatingOf(this, "tip");
    if (offset < 0) return;
    this.hoverTimer = setTimeout(() => this.hover(offset), 350);
  }

  private leave(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverAt = -1;
    // Let the pointer move onto the panel (to click a fix) before it closes.
    setTimeout(() => {
      if (floating?.owner === this && !floating.el.matches(":hover") && floating.el.classList.contains("tip")) closeFloating();
    }, 200);
  }

  private hover(offset: number): void {
    this.activate(this);
    const lines = new Lines(this.text);
    const pos = lines.position(offset);
    const here = this.current().filter((d) => {
      const s = lines.offset(d.range.start), e = lines.offset(d.range.end);
      return s <= offset && offset <= Math.max(e, s + 1);
    });
    const type = this.client.hover(this.uri, pos);
    if (!type && here.length === 0) return;

    const el = document.createElement("div");
    el.className = "float tip";
    if (type) {
      const pre = document.createElement("pre");
      pre.textContent = type.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      el.appendChild(pre);
    }
    for (const d of here) {
      const p = document.createElement("p");
      p.className = `m-${SEVERITY[d.severity ?? 1]}`;
      p.textContent = d.message + (d.code ? `  [${d.code}]` : "");
      el.appendChild(p);
      for (const fix of this.fixes(d)) {
        const b = document.createElement("button");
        b.textContent = (fix.isPreferred ? "✓ " : "") + fix.title;
        b.onclick = () => {
          closeFloating();
          const edits = fix.edit?.changes?.[this.uri] ?? [];
          this.setText(applyEdits(this.text, edits));
        };
        el.appendChild(b);
      }
    }
    el.addEventListener("mouseleave", () => closeFloating());
    closeFloating();
    floating = { el, owner: this };
    this.place(el, this.pointOf(offset));
  }

  private fixes(d: Diagnostic): CodeAction[] {
    try {
      return this.client.codeActions(this.uri, d.range, [d]).filter((a) => a.edit?.changes?.[this.uri]);
    } catch {
      return [];
    }
  }

  /// Reformat with the compiler's formatter (`ares fmt`).
  format(): void {
    this.activate(this);
    const edits = this.client.formatting(this.uri);
    if (edits.length) this.setText(applyEdits(this.text, edits));
  }
}

function closeFloatingOf(owner: Editor, cls: string): void {
  if (floating?.owner === owner && floating.el.classList.contains(cls)) closeFloating();
}

if (typeof document !== "undefined") {
  document.addEventListener("scroll", (e) => {
    if (floating && e.target instanceof Node && floating.el.contains(e.target)) return;
    closeFloating();
  }, { passive: true, capture: true });
}
