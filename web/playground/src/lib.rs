//! The browser playground: the Ares compiler (frontend + interpreter) built to
//! `wasm32-unknown-unknown` as a `cdylib` and driven from hand-written JS over
//! linear memory (no wasm-bindgen, no external crates).
//!
//! [`arx_eval`] takes UTF-8 Ares source, runs the same pipeline the native
//! `ares run` does (parse -> check -> lower -> IR -> interpret) against an
//! in-memory copy of the standard library, and returns the program's output (or
//! a rendered diagnostic). The `@extern` FFI is stubbed on wasm (no host libc),
//! so pure programs run fully and a foreign call reports a clear message.
//!
//! [`arx_lsp`] is the language server (`ares lsp`) over the same calls: the
//! page passes it one JSON-RPC message at a time and reads back what it sent.

use frontend::core::CoreProgram as LoweredProgram;

/// The playground-only module: routes I/O to JavaScript host imports (no libc
/// on wasm). Everything else comes from the standard library the compiler
/// carries ([`ares::stdlib::MODULES`]), so the two can never drift apart.
const HOST: &str = include_str!("host.ares");

/// A module's diagnostic path and source. The browser has no filesystem, so
/// these are `HOST` and the embedded standard library.
fn fetch(name: &str) -> Result<(String, String), String> {
    if name == "HOST" {
        return Ok(("HOST.ares".to_string(), HOST.to_string()));
    }
    match ares::stdlib::source(name) {
        Some(src) => Ok((ares::stdlib::path(name), src.to_string())),
        None => Err(format!("cannot find module `{name}`")),
    }
}

/// What to produce from a source, matching the site's mode selector.
/// 0 = run (default), 1 = generated C, 2 = IR, 3 = AST.
pub fn compile(user_src: &str, mode: i32) -> String {
    let result = match mode {
        1 => emit_c(user_src),
        2 => dump_ir(user_src),
        3 => dump_ast(user_src),
        _ => run(user_src),
    };
    match result {
        Ok(out) => out,
        Err(msg) => msg,
    }
}

/// Compile and run `user_src` (mode 0), returning the entry's exit code or a
/// rendered diagnostic. What the program prints goes to the host (`HOST.print`).
pub fn run_source(user_src: &str) -> String {
    compile(user_src, 0)
}

fn run(user_src: &str) -> Result<String, String> {
    let lowered = pipeline(user_src)?;
    let ir = frontend::ir::lower_modules(&lowered);
    // The entry is the program's `@main`, as everywhere else; the notebook has no
    // command line, so argv holds just the program name.
    match interpreter::machine::run_entry(&ir, frontend::ENTRY, vec!["playground".to_string()]) {
        Ok(code) => Ok(format!("exit {code}")),
        Err(diag) => Err(diag.render("", frontend::ENTRY)),
    }
}

fn emit_c(user_src: &str) -> Result<String, String> {
    let lowered = pipeline(user_src)?;
    // A conventional host target so the generated C reads normally, independent
    // of the wasm build the playground itself runs as.
    let target = utilities::Target {
        os: utilities::Os::Linux,
        arch: utilities::Arch::X86_64,
    };
    Ok(ccg::emit(&lowered, frontend::ENTRY, ccg::Entry::Main, target))
}

fn dump_ir(user_src: &str) -> Result<String, String> {
    let lowered = pipeline(user_src)?;
    Ok(format!("{:#?}", frontend::ir::lower_modules(&lowered)))
}

fn dump_ast(user_src: &str) -> Result<String, String> {
    match frontend::parse(user_src) {
        Ok(p) => {
            let mut out = format!(
                "module {} ({} items)\n",
                p.ast.text(p.program.module),
                p.program.items.len()
            );
            for item in p.ast.slice(p.program.items) {
                out.push_str(&format!("  {item:?}\n"));
            }
            Ok(out)
        }
        Err(diag) => Err(diag.render(user_src, "MAIN")),
    }
}

/// Load, check and lower `user_src` and every module it imports, root first,
/// through the same pipeline as the native compiler.
fn pipeline(user_src: &str) -> Result<Vec<LoweredProgram>, String> {
    ares::driver::compile_program(user_src, &fetch)
}

// -- the wasm C-ABI seam ----------------------------------------------------

/// Reserve `n` bytes in the module's linear memory and return the offset; the JS
/// host writes the source there before calling [`arx_eval`].
#[no_mangle]
pub extern "C" fn arx_alloc(n: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(n.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Release a buffer [`arx_alloc`] returned, once the call that read it is done.
#[no_mangle]
pub extern "C" fn arx_free(ptr: *mut u8, n: usize) {
    // SAFETY: `ptr` came from `arx_alloc(n)`, which leaked exactly this Vec.
    unsafe { drop(Vec::from_raw_parts(ptr, 0, n.max(1))) }
}

/// The result of the most recent [`arx_eval`], kept alive for the host to read
/// via [`arx_out_ptr`]/[`arx_out_len`]. Single-threaded (wasm), so a plain
/// static is sound.
static mut OUTPUT: Vec<u8> = Vec::new();

/// Compile the `len` source bytes at `ptr` in `mode` (0 run, 1 C, 2 IR, 3 AST);
/// the output is staged for [`arx_out_ptr`]/[`arx_out_len`]. Returns the output
/// length for convenience.
#[no_mangle]
pub extern "C" fn arx_compile(ptr: *const u8, len: usize, mode: i32) -> usize {
    let src = unsafe { std::slice::from_raw_parts(ptr, len) };
    let source = String::from_utf8_lossy(src).into_owned();
    stage(compile(&source, mode).into_bytes())
}

/// The offset of the staged output in linear memory.
#[no_mangle]
pub extern "C" fn arx_out_ptr() -> *const u8 {
    unsafe { (*std::ptr::addr_of!(OUTPUT)).as_ptr() }
}

/// The length of the staged output.
#[no_mangle]
pub extern "C" fn arx_out_len() -> usize {
    unsafe { (*std::ptr::addr_of!(OUTPUT)).len() }
}

// -- the language server ---------------------------------------------------

/// Where the page's documents live. The browser has no filesystem, so these
/// paths are names only; `HOST` sits beside the cells so `$ with HOST` resolves
/// to it the way a sibling file would.
const LSP_ROOT: &str = "/playground";

static mut LSP: Option<ares::lsp::server::Server> = None;

fn lsp() -> &'static mut ares::lsp::server::Server {
    // SAFETY: wasm is single-threaded and every caller is a top-level export,
    // so no two references are ever live at once.
    let slot = unsafe { &mut *std::ptr::addr_of_mut!(LSP) };
    slot.get_or_insert_with(|| {
        let mut server = ares::lsp::server::Server::queued();
        server.provide(std::path::PathBuf::from(format!("{LSP_ROOT}/HOST.ares")), HOST.to_string());
        server
    })
}

/// Stage what the server sent as one JSON array.
fn stage_outbox() -> usize {
    let sent = utilities::Json::Arr(lsp().take_outbox());
    stage(sent.to_string().into_bytes())
}

fn stage(out: Vec<u8>) -> usize {
    let n = out.len();
    unsafe {
        *std::ptr::addr_of_mut!(OUTPUT) = out;
    }
    n
}

fn input(ptr: *const u8, len: usize) -> String {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

/// Hand the server one JSON-RPC message (no `Content-Length` framing) and stage
/// every message it sent in response, a reply included, as a JSON array.
#[no_mangle]
pub extern "C" fn arx_lsp(ptr: *const u8, len: usize) -> usize {
    let msg = utilities::Json::parse(&input(ptr, len)).unwrap_or(utilities::Json::Null);
    let _ = lsp().handle(msg);
    stage_outbox()
}

/// Run the server's deferred work (debounced checks, held-back errors, error
/// ranking) and stage what it sent, as [`arx_lsp`] does.
#[no_mangle]
pub extern "C" fn arx_lsp_tick() -> usize {
    lsp().tick();
    stage_outbox()
}

/// Milliseconds until [`arx_lsp_tick`] has work, or -1 when it has none.
#[no_mangle]
pub extern "C" fn arx_lsp_wake() -> f64 {
    match lsp().wake_in() {
        Some(d) => d.as_secs_f64() * 1000.0,
        None => -1.0,
    }
}

/// Semantic tokens (the LSP's encoding) for a buffer that is not open, so the
/// page can color every cell without checking each one.
#[no_mangle]
pub extern "C" fn arx_highlight(ptr: *const u8, len: usize) -> usize {
    stage(ares::lsp::server::highlight(&input(ptr, len)).to_string().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::run_source;
    use utilities::Json;

    // Every module a cell can import has to type-check with no filesystem behind
    // it: `IO` and friends come from the embedded stdlib, and `C` is stubbed by
    // the JS host.
    #[test]
    fn every_bundled_module_is_importable() {
        let names = ares::stdlib::MODULES.iter().map(|(n, _)| *n).chain(["HOST"]);
        for name in names {
            let src = format!(
                "$ @mod MAIN\n$ with {name}\n\
                 $ @main : @Vec @Str -> <@IO> @Int = \\args => 0\n"
            );
            let out = run_source(&src);
            assert_eq!(out, "exit 0", "`$ with {name}` does not compile:\n{out}");
        }
    }

    fn send(server: &mut ares::lsp::server::Server, msg: &str) -> Vec<Json> {
        server.handle(Json::parse(msg).expect("valid JSON"));
        server.take_outbox()
    }

    // The page's language server: a cell importing the playground-only `HOST`
    // resolves it with no file behind it, reports a type error, and answers a
    // hover, all through the queued server the wasm exports drive.
    #[test]
    fn language_server_checks_a_cell() {
        let server = super::lsp();
        let uri = "file:///playground/cell.ares";
        let src = "$ @mod MAIN\n$ with HOST\n$ n : @Int = 1\n$ @main : @Vec @Str -> <@IO> @Int = \\args => HOST.print \"x\"; n + \"y\"\n";
        send(server, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
        let open = Json::obj([
            ("jsonrpc", Json::str("2.0")),
            ("method", Json::str("textDocument/didOpen")),
            (
                "params",
                Json::obj([(
                    "textDocument",
                    Json::obj([("uri", Json::str(uri)), ("version", Json::int(1)), ("text", Json::str(src))]),
                )]),
            ),
        ]);
        send(server, &open.to_string());
        server.tick();
        let sent = server.take_outbox();
        let diags = sent
            .iter()
            .find(|m| m.get("method").as_str() == Some("textDocument/publishDiagnostics"))
            .expect("diagnostics published")
            .get("params")
            .get("diagnostics")
            .clone();
        let messages: Vec<String> =
            diags.as_arr().iter().map(|d| d.get("message").as_str().unwrap_or("").to_string()).collect();
        assert!(!messages.iter().any(|m| m.contains("HOST")), "HOST did not resolve: {messages:?}");
        assert!(!messages.is_empty(), "the type error was not reported");

        let hover = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{{"textDocument":{{"uri":"{uri}"}},"position":{{"line":2,"character":2}}}}}}"#
        );
        let reply = send(server, &hover);
        let shown = reply[0].get("result").get("contents").get("value").as_str().unwrap_or("").to_string();
        assert!(shown.contains("n : @Int"), "{shown}");
    }

    #[test]
    fn highlights_without_opening() {
        let tokens = ares::lsp::server::highlight("$ x : @Int = 1 # one\n");
        assert!(!tokens.get("data").as_arr().is_empty());
    }

    #[test]
    fn runs_a_program() {
        let src = "$ @mod MAIN\n$ @main : @Vec @Str -> <@IO> @Int = \\args => 6 * 7 - 42\n";
        assert_eq!(run_source(src), "exit 0");
    }

    #[test]
    fn imports_the_bundled_stdlib() {
        let src = "$ @mod MAIN\n\
                   $ with STR\n\
                   $ @main : @Vec @Str -> <@IO> @Int = \\args =>\n\
                   \tif STR.from_int 123 == \"123\" => 0 else 1\n";
        assert_eq!(run_source(src), "exit 0");
    }

    #[test]
    fn imports_under_an_alias() {
        let src = "$ @mod MAIN\n\
                   $ with S = STR\n\
                   $ @main : @Vec @Str -> <@IO> @Int = \\args =>\n\
                   \tif S.from_int 123 == \"123\" => 0 else 1\n";
        assert_eq!(run_source(src), "exit 0");
    }

    #[test]
    fn reports_a_type_error() {
        let src = "$ @mod MAIN\n$ @main : @Vec @Str -> <@IO> @Int = \\args => \"x\" + 1\n";
        let out = run_source(src);
        assert!(out.contains("error") || out.contains("mismatch"), "{out}");
    }

    #[test]
    fn bundles_the_host_module() {
        // `HOST.print` reaches a JS import only on wasm, so it faults if run
        // natively. Checking the IR still exercises parsing, resolution, and
        // type-checking of the bundled `HOST` module end to end.
        let src = "$ @mod MAIN\n\
                   $ with HOST\n\
                   $ @main : @Vec @Str -> <@IO> @Int = \\args => HOST.print \"hi\"; 0\n";
        let ir = super::compile(src, 2);
        assert!(!ir.to_lowercase().contains("error"), "{ir}");
        assert!(ir.contains("WASM"), "{ir}");
        assert!(ir.contains("\"print\""), "{ir}");
    }
}
