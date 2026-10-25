//! The browser playground: the Thrax compiler (frontend + interpreter) built to
//! `wasm32-unknown-unknown` as a `cdylib` and driven from hand-written JS over
//! linear memory (no wasm-bindgen, no external crates).
//!
//! [`thx_eval`] takes UTF-8 Thrax source, runs the same pipeline the native
//! `thrax run` does (parse -> check -> lower -> IR -> interpret) against an
//! in-memory copy of the standard library, and returns the program's output (or
//! a rendered diagnostic). The `@extern` FFI is stubbed on wasm (no host libc),
//! so pure programs run fully and a foreign call reports a clear message.

use frontend::lowering::data::Program as LoweredProgram;
use frontend::{Ast, Item, Program};

/// The bundled standard library: module name to source text, one entry per
/// `library/*.thx`, plus the playground-only `HOST`. Embedded at build time so
/// the wasm module needs no filesystem. A new `library/*.thx` must be added
/// here too; the tests below enforce it.
const MODULES: &[(&str, &str)] = &[
    ("C", include_str!("../../../../library/C.thx")),
    ("CORE", include_str!("../../../../library/CORE.thx")),
    ("CPX", include_str!("../../../../library/CPX.thx")),
    ("DERIVE", include_str!("../../../../library/DERIVE.thx")),
    ("IO", include_str!("../../../../library/IO.thx")),
    ("LA", include_str!("../../../../library/LA.thx")),
    ("MAP", include_str!("../../../../library/MAP.thx")),
    ("MATH", include_str!("../../../../library/MATH.thx")),
    ("OPT", include_str!("../../../../library/OPT.thx")),
    ("PATH", include_str!("../../../../library/PATH.thx")),
    ("RANDOM", include_str!("../../../../library/RANDOM.thx")),
    ("RESULT", include_str!("../../../../library/RESULT.thx")),
    ("SET", include_str!("../../../../library/SET.thx")),
    ("STR", include_str!("../../../../library/STR.thx")),
    ("VEC", include_str!("../../../../library/VEC.thx")),
    // Playground-only: routes I/O to JavaScript host imports (no libc on wasm).
    ("HOST", include_str!("host.thx")),
];

fn stdlib_source(name: &str) -> Option<&'static str> {
    MODULES.iter().find(|(n, _)| *n == name).map(|(_, src)| *src)
}

/// The modules a parsed program imports (`$ with MOD`).
fn imports_of(ast: &Ast, program: &Program) -> Vec<String> {
    ast.slice(program.items)
        .iter()
        .filter_map(|item| match item {
            Item::Import { module, .. } => Some(
                ast.slice(*module)
                    .iter()
                    .map(|&part| ast.text(part))
                    .collect::<Vec<_>>()
                    .join("."),
            ),
            _ => None,
        })
        .collect()
}

/// Postorder DFS: a module appears after every module it imports.
fn topological_order(graph: &[Vec<usize>]) -> Vec<usize> {
    fn visit(v: usize, graph: &[Vec<usize>], seen: &mut [bool], order: &mut Vec<usize>) {
        if seen[v] {
            return;
        }
        seen[v] = true;
        for &w in &graph[v] {
            visit(w, graph, seen, order);
        }
        order.push(v);
    }
    let mut seen = vec![false; graph.len()];
    let mut order = Vec::with_capacity(graph.len());
    for v in 0..graph.len() {
        visit(v, graph, &mut seen, &mut order);
    }
    order
}

/// Every module of a compilation, parsed into one shared arena.
struct Loaded<'a> {
    ast: Ast,
    /// Per module, parallel to `programs`: its name and source text. The source
    /// is what a diagnostic renders against.
    sources: Vec<(String, &'a str)>,
    programs: Vec<Program>,
    index: std::collections::HashMap<String, usize>,
    root: usize,
}

/// Parse the user source and, transitively, every standard-library module it
/// imports, into one arena. Mirrors the driver's `load_core`, but every
/// dependency comes from [`MODULES`] rather than from disk.
///
/// A module is parsed exactly once: its imports are read off the AST, not off a
/// throwaway re-parse of its text.
fn load(user_src: &str) -> Result<Loaded<'_>, String> {
    let mut ast = Ast::new();
    let mut sources: Vec<(String, &str)> = Vec::new();
    let mut programs: Vec<Program> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // The root module names itself (`$ @mod NAME`); a source too broken to parse
    // has no name to report a diagnostic against, so it borrows the usual one.
    let root_program = match frontend::parse_into(ast, user_src) {
        Ok((next, p)) => {
            ast = next;
            p
        }
        Err(diag) => return Err(diag.render(user_src, "MAIN")),
    };
    let root_name = ast.text(root_program.module).to_string();
    let mut pending = imports_of(&ast, &root_program);
    index.insert(root_name.clone(), 0);
    sources.push((root_name, user_src));
    programs.push(root_program);

    // `CORE` is implicitly imported into every module (its `to_string`, its
    // instances, the operators) and `C` is the auto-injected libc namespace,
    // reachable qualified with no import. Both are always part of the program.
    pending.push("CORE".to_string());
    pending.push("C".to_string());

    while let Some(name) = pending.pop() {
        if index.contains_key(&name) {
            continue;
        }
        let Some(src) = stdlib_source(&name) else {
            return Err(format!("cannot find module `{name}`"));
        };
        let program = match frontend::parse_into(ast, src) {
            Ok((next, p)) => {
                ast = next;
                p
            }
            Err(diag) => return Err(diag.render(src, &name)),
        };
        for imp in imports_of(&ast, &program) {
            if !index.contains_key(&imp) {
                pending.push(imp);
            }
        }
        index.insert(name.clone(), programs.len());
        sources.push((name, src));
        programs.push(program);
    }

    Ok(Loaded {
        ast,
        sources,
        programs,
        index,
        root: 0,
    })
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

/// The pipeline up to (not including) execution: load, parse, check, and lower
/// every module against the in-memory standard library. Returns the lowered
/// modules, root first.
fn pipeline(user_src: &str) -> Result<Vec<LoweredProgram>, String> {
    let Loaded {
        ast,
        sources,
        programs,
        index,
        root,
    } = load(user_src)?;

    // Dependency graph (edges point at imports).
    let mut graph = vec![Vec::new(); programs.len()];
    for (i, program) in programs.iter().enumerate() {
        for name in imports_of(&ast, program) {
            if let Some(&j) = index.get(&name) {
                graph[i].push(j);
            }
        }
    }

    // Type-check in dependency order, `C` and `CORE` first: `C` qualified-only
    // (`C.sqrt`), `CORE` bare (its `to_string` and its instances), injected
    // into every other module. Mirrors the driver.
    let c_idx = index.get("C").copied();
    let core_idx = index.get("CORE").copied();
    let mut order = topological_order(&graph);
    for &pre in [core_idx, c_idx].iter().flatten() {
        order.retain(|&i| i != pre);
        order.insert(0, pre);
    }
    // One type store for the whole compilation: a `Type` is a handle into it, so
    // a type crossing a module boundary has to address the same store.
    let types = std::rc::Rc::new(frontend::Types::new());
    let mut checkers: Vec<Option<frontend::Checker>> = (0..programs.len()).map(|_| None).collect();
    for i in order {
        let mut checker = frontend::Checker::new(&ast, types.clone());
        if let Some(c) = c_idx {
            if c != i && Some(i) != core_idx {
                checker.import_qualified(checkers[c].as_ref().expect("C checked first"));
            }
        }
        if let Some(core) = core_idx {
            if core != i && Some(i) != c_idx {
                checker.import_from(checkers[core].as_ref().expect("CORE checked first"));
            }
        }
        for &dep in &graph[i] {
            checker.import_from(checkers[dep].as_ref().expect("dependency checked first"));
        }
        match checker.check_program(&programs[i]) {
            Ok(_) => checkers[i] = Some(checker),
            Err(diag) => {
                let (name, src) = &sources[i];
                return Err(diag.render(src, name));
            }
        }
    }
    let checkers: Vec<frontend::Checker> =
        checkers.into_iter().map(|c| c.expect("all checked")).collect();

    let resolved = frontend::collect_resolved(&checkers);

    // Lower every module (root first so its names win the unqualified fallback).
    let decls = frontend::Decls::collect(&ast, &programs);
    let mut lower_order: Vec<usize> = (0..programs.len()).collect();
    lower_order.sort_by_key(|&i| i != root);
    let lowered: Vec<LoweredProgram> = lower_order
        .iter()
        .map(|&i| frontend::lower_program(&ast, &programs[i], &decls, &resolved))
        .collect();

    if !lowered[0].globals.iter().any(|(n, _)| n == frontend::ENTRY) {
        return Err(format!(
            "module `{}` has no `$ {} : {}` to run",
            sources[root].0,
            frontend::ENTRY,
            frontend::ENTRY_SIG
        ));
    }

    Ok(lowered)
}

// -- the wasm C-ABI seam ----------------------------------------------------

/// Reserve `n` bytes in the module's linear memory and return the offset; the JS
/// host writes the source there before calling [`thx_eval`].
#[no_mangle]
pub extern "C" fn thx_alloc(n: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(n.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// The result of the most recent [`thx_eval`], kept alive for the host to read
/// via [`thx_out_ptr`]/[`thx_out_len`]. Single-threaded (wasm), so a plain
/// static is sound.
static mut OUTPUT: Vec<u8> = Vec::new();

/// Compile the `len` source bytes at `ptr` in `mode` (0 run, 1 C, 2 IR, 3 AST);
/// the output is staged for [`thx_out_ptr`]/[`thx_out_len`]. Returns the output
/// length for convenience.
#[no_mangle]
pub extern "C" fn thx_compile(ptr: *const u8, len: usize, mode: i32) -> usize {
    let src = unsafe { std::slice::from_raw_parts(ptr, len) };
    let source = String::from_utf8_lossy(src).into_owned();
    let out = compile(&source, mode).into_bytes();
    let n = out.len();
    unsafe {
        *std::ptr::addr_of_mut!(OUTPUT) = out;
    }
    n
}

/// The offset of the staged output in linear memory.
#[no_mangle]
pub extern "C" fn thx_out_ptr() -> *const u8 {
    unsafe { (*std::ptr::addr_of!(OUTPUT)).as_ptr() }
}

/// The length of the staged output.
#[no_mangle]
pub extern "C" fn thx_out_len() -> usize {
    unsafe { (*std::ptr::addr_of!(OUTPUT)).len() }
}

#[cfg(test)]
mod tests {
    use super::{run_source, MODULES};

    // The playground embeds the standard library rather than reading it, so a
    // module added to `library/` is invisible here until it is listed. Catches
    // the drift that makes `$ with NEW` report "cannot find module".
    #[test]
    fn embedded_modules_match_the_library_directory() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../library");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .expect("read library/")
            .flatten()
            .map(|entry| entry.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("thx"))
            .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(String::from))
            .collect();
        on_disk.sort();
        // HOST is the playground's own, with no file in `library/`.
        let mut embedded: Vec<String> = MODULES
            .iter()
            .map(|(n, _)| n.to_string())
            .filter(|n| n != "HOST")
            .collect();
        embedded.sort();
        assert_eq!(
            embedded, on_disk,
            "a new library/*.thx must be added to MODULES"
        );
    }

    // Catches a mis-paired `include_str!` among sixteen near-identical lines.
    #[test]
    fn embedded_sources_declare_their_own_module_name() {
        for (name, src) in MODULES {
            assert_eq!(src.lines().next(), Some(format!("$ @mod {name}").as_str()));
        }
    }

    // Every bundled module has to type-check in the playground's own module
    // graph, which differs from the driver's: `IO` and friends are reached
    // without a filesystem, and `C` is stubbed by the JS host.
    #[test]
    fn every_bundled_module_is_importable() {
        for (name, _) in MODULES {
            let src = format!(
                "$ @mod MAIN\n$ with {name}\n\
                 $ @main : @Vec @Str -> <@IO> @Int = \\args = 0\n"
            );
            let out = run_source(&src);
            assert_eq!(out, "exit 0", "`$ with {name}` does not compile:\n{out}");
        }
    }

    #[test]
    fn runs_a_program() {
        let src = "$ @mod MAIN\n$ @main : @Vec @Str -> <@IO> @Int = \\args = 6 * 7 - 42\n";
        assert_eq!(run_source(src), "exit 0");
    }

    #[test]
    fn imports_the_bundled_stdlib() {
        let src = "$ @mod MAIN\n\
                   $ with STR\n\
                   $ @main : @Vec @Str -> <@IO> @Int = \\args =\n\
                   \tif STR.from_int 123 == \"123\" => 0 else 1\n";
        assert_eq!(run_source(src), "exit 0");
    }

    #[test]
    fn reports_a_type_error() {
        let src = "$ @mod MAIN\n$ @main : @Vec @Str -> <@IO> @Int = \\args = \"x\" + 1\n";
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
                   $ @main : @Vec @Str -> <@IO> @Int = \\args = HOST.print \"hi\"; 0\n";
        let ir = super::compile(src, 2);
        assert!(!ir.to_lowercase().contains("error"), "{ir}");
        assert!(ir.contains("WASM"), "{ir}");
        assert!(ir.contains("\"print\""), "{ir}");
    }
}
