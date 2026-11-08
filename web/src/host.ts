// The host side of the playground wasm: its imports (the `@extern "WASM"` call
// trampoline the interpreter speaks, see `run_extern` in
// crates/interpreter/src/machine/ffi.rs, and the language server's clock) and
// typed wrappers over its exports. The wasm module knows none of the registered
// host function names; adding one is purely a page concern (`register`).

/// What `@extern "WASM"` functions may take and return.
export type HostValue = bigint | number | string | undefined;
export type HostFn = (...args: HostValue[]) => HostValue | void;

/// The wasm module's exports: a raw C ABI over linear memory. Every `arx_*`
/// call that produces text stages it for `arx_out_ptr`/`arx_out_len`.
interface Exports {
  memory: WebAssembly.Memory;
  arx_alloc(n: number): number;
  arx_free(ptr: number, n: number): void;
  arx_compile(ptr: number, len: number, mode: number): number;
  arx_lsp(ptr: number, len: number): number;
  arx_lsp_tick(): number;
  arx_lsp_wake(): number;
  arx_highlight(ptr: number, len: number): number;
  arx_out_ptr(): number;
  arx_out_len(): number;
}

/// What `compile` produces: 0 runs the program, the others show a stage.
export const Mode = { Run: 0, C: 1, Ir: 2, Ast: 3 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export interface Host {
  imports: WebAssembly.Imports;
  bind(exports: WebAssembly.Exports): void;
  register(name: string, fn: HostFn): void;
  /// The text the program printed, then the compiler's result.
  compile(src: string, mode: Mode): string;
  /// One JSON-RPC message to the language server; what it sent back.
  lsp(message: string): string;
  lspTick(): string;
  /// Milliseconds until `lspTick` has work, or -1.
  lspWake(): number;
  highlight(src: string): string;
}

export function createHost(): Host {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let wasm: Exports | null = null;
  const exp = (): Exports => {
    if (!wasm) throw new Error("the playground wasm is not bound yet");
    return wasm;
  };

  // Whatever the running program prints through a host function, per compile.
  let printed = "";

  // The interpreter runs to completion before the browser repaints, so a program
  // that changes color in a loop would only ever show its last color. The colors
  // it asks for are collected during the run and played back on a timer after.
  const hasDom = typeof document !== "undefined";
  let colors: string[] = [];
  let colorTimer: ReturnType<typeof setInterval> | null = null;
  let playbackDelay = 180;

  function playColors(): void {
    if (colorTimer) { clearInterval(colorTimer); colorTimer = null; }
    if (!hasDom || colors.length === 0) return;
    let i = 0;
    const show = () => document.documentElement.style.setProperty("--card", colors[i++ % colors.length]);
    show();
    if (colors.length > 1) colorTimer = setInterval(show, playbackDelay);
  }

  const registry: Record<string, HostFn> = {
    print(s) { printed += String(s) + "\n"; },
    change_color(color) { colors.push(String(color)); },
    random(n) { return Math.floor(Math.random() * Number(n)); },
    delay(ms) { playbackDelay = Number(ms); },
  };

  const mem = () => new Uint8Array(exp().memory.buffer);
  const view = () => new DataView(exp().memory.buffer);

  // The interpreter's kind-tagged argument buffer: 0 unit, 1 i64, 2 f64,
  // 3 u32 length + UTF-8 bytes.
  function decodeArgs(ptr: number, len: number): HostValue[] {
    const m = mem(), v = view();
    const args: HostValue[] = [];
    let o = ptr;
    const end = ptr + len;
    while (o < end) {
      const kind = m[o++];
      if (kind === 0) { args.push(undefined); }
      else if (kind === 1) { args.push(v.getBigInt64(o, true)); o += 8; }
      else if (kind === 2) { args.push(v.getFloat64(o, true)); o += 8; }
      else if (kind === 3) {
        const n = v.getUint32(o, true); o += 4;
        args.push(dec.decode(m.subarray(o, o + n))); o += n;
      } else break;
    }
    return args;
  }

  let retInt = 0n, retReal = 0;
  let retBytes: Uint8Array | null = null;

  const env = {
    arx_host_call(symPtr: number, symLen: number, argsPtr: number, argsLen: number): number {
      const name = dec.decode(mem().subarray(symPtr, symPtr + symLen));
      const fn = registry[name];
      if (typeof fn !== "function") return -1;
      const r = fn(...decodeArgs(argsPtr, argsLen));
      if (r === undefined || r === null) return 0;
      if (typeof r === "bigint") { retInt = r; return 1; }
      if (typeof r === "number") {
        if (Number.isInteger(r)) { retInt = BigInt(r); return 1; }
        retReal = r; return 2;
      }
      if (typeof r === "string") { retBytes = enc.encode(r); return 3; }
      return 0;
    },
    arx_host_ret_int: () => retInt,
    arx_host_ret_real: () => retReal,
    arx_host_ret_len: () => (retBytes ? retBytes.length : 0),
    arx_host_ret_copy(dst: number): void { if (retBytes) mem().set(retBytes, dst); },
    arx_host_now_ms: () => performance.now(),
  };

  // Any import other than `env`'s is answered with a no-op, so an unrelated
  // import can never block instantiation.
  const imports = new Proxy({}, {
    get: (_t, module) => new Proxy(module === "env" ? env : {}, {
      get: (target: Record<string, unknown>, name: string) => (name in target ? target[name] : () => 0),
    }),
  }) as WebAssembly.Imports;

  function staged(): string {
    const w = exp();
    return dec.decode(mem().subarray(w.arx_out_ptr(), w.arx_out_ptr() + w.arx_out_len()));
  }

  /// Copy `text` into wasm memory for the length of `call`.
  function withInput(text: string, call: (ptr: number, len: number) => void): string {
    const bytes = enc.encode(text);
    const ptr = exp().arx_alloc(bytes.length);
    mem().set(bytes, ptr);
    try {
      call(ptr, bytes.length);
    } finally {
      exp().arx_free(ptr, bytes.length);
    }
    return staged();
  }

  function compile(src: string, mode: Mode): string {
    printed = "";
    colors = [];
    playbackDelay = 180;
    if (colorTimer) { clearInterval(colorTimer); colorTimer = null; }
    if (hasDom) document.documentElement.style.removeProperty("--card");
    const out = withInput(src, (p, n) => exp().arx_compile(p, n, mode));
    playColors();
    return printed + out;
  }

  return {
    imports,
    bind: (exports) => { wasm = exports as unknown as Exports; },
    register: (name, fn) => { registry[name] = fn; },
    compile,
    lsp: (message) => withInput(message, (p, n) => exp().arx_lsp(p, n)),
    lspTick: () => { exp().arx_lsp_tick(); return staged(); },
    lspWake: () => exp().arx_lsp_wake(),
    highlight: (src) => withInput(src, (p, n) => exp().arx_highlight(p, n)),
  };
}
