// A language-server client for `thrax lsp` running inside the playground wasm.
// The server is the real one (crates/thrax/src/lsp), driven one message at a
// time: a call into wasm returns every message the server sent, so a request's
// reply is available synchronously. Deferred work (the debounced check after
// typing, held-back errors, error ranking) runs on a timer the server sets.

import type { Host } from "./host.ts";

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface TextEdit { range: Range; newText: string }

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: string;
  message: string;
  /// `role` is the server's ranking: focus, root, consequence, grace or lint.
  data?: { role?: string };
}

export interface CompletionItem { label: string; detail?: string; kind?: number }

export interface CodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: { changes?: Record<string, TextEdit[]> };
}

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

export type DiagnosticsListener = (uri: string, version: number, diagnostics: Diagnostic[]) => void;

export class Client {
  private host: Host;
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private versions = new Map<string, number>();
  /// The semantic token classes, in the order the server numbers them.
  readonly tokenTypes: string[];
  onDiagnostics: DiagnosticsListener = () => {};

  constructor(host: Host) {
    this.host = host;
    const init = this.request("initialize", { capabilities: {} }) as {
      capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[] } } };
    } | null;
    this.tokenTypes = init?.capabilities?.semanticTokensProvider?.legend?.tokenTypes ?? [];
    this.notify("initialized", {});
  }

  request(method: string, params: unknown): unknown {
    const id = this.nextId++;
    const sent = this.deliver(this.host.lsp(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    const reply = sent.find((m) => m.id === id);
    if (reply?.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply?.result ?? null;
  }

  notify(method: string, params: unknown): void {
    this.deliver(this.host.lsp(JSON.stringify({ jsonrpc: "2.0", method, params })));
  }

  /// Dispatch the server's notifications and re-arm the tick timer.
  private deliver(raw: string): Message[] {
    const sent = JSON.parse(raw) as Message[];
    for (const m of sent) {
      if (m.method === "textDocument/publishDiagnostics") {
        const p = m.params as { uri: string; version?: number; diagnostics: Diagnostic[] };
        this.onDiagnostics(p.uri, p.version ?? 0, p.diagnostics);
      }
    }
    this.schedule();
    return sent;
  }

  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const wait = this.host.lspWake();
    if (wait < 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deliver(this.host.lspTick());
    }, Math.ceil(wait));
  }

  /// Stop the tick timer (a script that is done with the client).
  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  isOpen(uri: string): boolean { return this.versions.has(uri); }
  version(uri: string): number { return this.versions.get(uri) ?? 0; }

  open(uri: string, text: string): void {
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "thrax", version: 1, text } });
  }

  change(uri: string, text: string): void {
    const version = this.version(uri) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  close(uri: string): void {
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  hover(uri: string, position: Position): string | null {
    const r = this.request("textDocument/hover", { textDocument: { uri }, position }) as {
      contents?: { value?: string };
    } | null;
    return r?.contents?.value ?? null;
  }

  completion(uri: string, position: Position): CompletionItem[] {
    const r = this.request("textDocument/completion", { textDocument: { uri }, position }) as {
      items?: CompletionItem[];
    } | null;
    return r?.items ?? [];
  }

  formatting(uri: string): TextEdit[] {
    const r = this.request("textDocument/formatting", {
      textDocument: { uri }, options: { tabSize: 4, insertSpaces: true },
    });
    return (r as TextEdit[] | null) ?? [];
  }

  codeActions(uri: string, range: Range, diagnostics: Diagnostic[]): CodeAction[] {
    const r = this.request("textDocument/codeAction", {
      textDocument: { uri }, range, context: { diagnostics, only: ["quickfix"] },
    });
    return (r as CodeAction[] | null) ?? [];
  }

  /// Semantic tokens for text that need not be open: the server's own lexer,
  /// so the page carries no grammar.
  highlight(text: string): number[] {
    const r = JSON.parse(this.host.highlight(text)) as { data?: number[] } | null;
    return r?.data ?? [];
  }
}
