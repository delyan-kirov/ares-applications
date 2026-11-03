# Applications

Programs written *in* Thrax, using the language as an SDK: the compiler, the
standard library, and the C FFI are the platform, and each subdirectory here is a
self-contained app built on top of it.

The intent is for each app to be its own repository, added here as a **git
submodule**, so an app has its own history and can be developed independently
while still sitting inside the Thrax tree for a batteries-included dev shell. (An
app can also just live here as a plain directory, as the launcher does today.)

Each app carries its own `flake.nix` providing whatever native libraries it binds
(raylib, etc.) plus the display/runtime deps, and a shell hook that links the
Thrax standard `library/` and any shared objects into place so the directory is
self-contained.

## Apps

- **[launcher](launcher/)** -- a raylib program launcher. The first app to use
  the C-struct FFI (`@struct @extern "C"`, structs passed to C by value).
- **[cbindgen](cbindgen/)** -- a C-header binding generator written in Thrax:
  reads a `.h`, emits Thrax `@extern` bindings for its enums, structs, unions, and
  functions.
- **[xml](xml/)** -- an XML parser, serializer and query engine built on
  algebraic effects: the cursor is a handler's parameter, an alternative is a
  `fork` the handler resumes twice (so backtracking rewinds the input by
  itself), and the same effect drives the query engine.
- **[alec](alec/)** -- a C compiler written in Thrax, compiling C11 (with
  the common GNU extensions and its own C library) to WebAssembly, wasm32 or
  wasm64. Every stage runs on algebraic effects: the preprocessor is a
  coroutine that the parser pulls tokens from, and code generation falls back
  to flattening a function when a jump does not fit structured control flow.
- **[zalmoxis](zalmoxis/)**: a line counter in the manner of tokei: code,
  comments and blanks per language, with tokei's rules and its walk
  (gitignore, hidden files). The tree is walked and counted in parallel, and
  on ordinary repositories it runs within about 1.3x of tokei.
- **[web](web/)**: the browser playground. The compiler and its language
  server built to `wasm32-unknown-unknown` and driven from a small TypeScript
  page with no dependencies, so every example is compiled, run and checked as
  you type, client-side. The examples are Thrax files in `web/cells/`. Build
  with `node web/build.ts` (in the `web/` dev shell) after any change to
  `crates/`, `library/` or `web/`: it rebuilds the checked-in
  `site/playground.wasm`, emits the page's JavaScript with `tsc`, and runs the
  smoke test.

## Adding an app as a submodule

From the repo root:

```
git submodule add <repo-url> applications/<name>
```

Give the app a `flake.nix` (see `launcher/flake.nix`) and a `MAIN.thx` with an
entry point, `$ @main : @Vec @Str -> <@IO> @Int`. Run it with `thrax run MAIN.thx`
(interpreter) or `thrax build MAIN.thx` (native binary) from the app's own
directory.
