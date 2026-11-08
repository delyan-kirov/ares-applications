# Ares Launcher

A tiny program launcher written in Ares against [raylib](https://www.raylib.com/).
Type to filter the list, then click a button to spawn the program it names, or
lead the query with a sigil to run a command, search the web, or invoke a tool.

The whole raylib API is imported from `RAYLIB.ares`, which is **generated** by the
cbindgen tool (`applications/cbindgen`) from raylib's header. `MAIN.ares` just does
`$ @import RAYLIB` and calls the bindings. It showcases Ares's **C-struct FFI**:
raylib's `Color` is a real `@struct @extern "C"` passed **by value**, built with
an ordinary struct literal.

A C function is never curried, so a raylib call with several parameters takes a
**record** of its arguments (fields named `p0`, `p1`, ... in C order); a
one-parameter call stays `A -> B`, and a `void`-taking call takes unit:

```
$ @import RAYLIB
...
clearBackground (Color.{ .r = 24, .g = 24, .b = 32, .a = 255 })      # one arg
drawRectangle { .p0 = x, .p1 = y, .p2 = w, .p3 = h, .p4 = col }      # a record
beginDrawing {}                                                       # unit
```

The generated bindings use the `@`-sigil built-in types (`@Int32`, `@Nat8`, ...),
so coordinates are `@Int32`; the app stays integer-only (positions, sizes, the
mouse via `getMouseX`/`getMouseY`), no floats.

## Type-to-search

The search box reads keystrokes with raylib's `getCharPressed` and filters the
list by a case-insensitive substring match. `getCharPressed` returns a C `int`
(`@Int32`), but the string library works in `Int`, and those widths are distinct
types. The `@cast` intrinsic bridges them:

```
$ read_chars : @Str -> @Str = \q =>
	let c = getCharPressed {} in            # c : @Int32
	if c == 0 => q
	else if c >= 32 && c < 127 => read_chars (q ++ from_byte (@cast c))
	else read_chars q                       # from_byte wants Int; @cast c widens it
```

`@cast` reinterprets an integer at another width. It is type-directed: the target
comes from the checking context (an argument position or an annotated binding),
so `from_byte (@cast c)` casts to `Int` because `from_byte : Int -> @Str`. Both
engines box integers uniformly, so it is a no-op at runtime; the actual C width is
applied only at the `@extern` boundary.

## Command modes

The first byte of the query picks a mode; press **Enter** to commit it. With no
sigil the query filters the app list, and Enter launches the first match.

| Prefix | Example    | Effect |
| ------ | ---------- | ------ |
| `!`    | `! uname`  | Run the command and show its output in the window (killed after `cmd_timeout` seconds). |
| `?`    | `? raylib` | Open the query as a web search, then close the launcher. |
| `$`    | `$time`    | Run a curated tool and show its output. |

The `$` tools are a small table in `MAIN.ares`: `time` runs `date`, `cal` runs
`cal`, `disk` runs `df -h`, `mem` runs `free -h`. An unknown name leaves the
query in place so the typo stays visible. The dispatch is a string-prefix match:

```
m.query |> \
| "!" ++ cmd  => show_output m (run_capture (trim cmd))
| "?" ++ q    => open_search (trim q) ; break {}
| "$" ++ name => ...
| _           => when (VEC.first m.visible) <| \a => launch a ; break {}
```

The terminal (for `Terminal=true` apps) and the search engine are editable
constants at the top of the file.

## How it is put together

The UI state is one `Model` record, reached through an effect instead of being
threaded through every function:

```
$ Ui : @effect = model : {} -> Model, set : Model -> {},
```

`with_model` handles it by passing the model along, and the frame loop is CORE's
`for` over the infinite `forever` stream. Each frame is a few steps that read and
update the model; `break` (CORE's `Loop` effect) ends the loop, and `@finale` closes
the window however it ends:

```
@finale (\_ => closeWindow {}) <| \_ =>
@finale (\_ => unloadFont font) <| \_ =>
(with_model m0 <| \u =>
	@finale stop_scan <| \_ =>
	for forever <| \_ => frame font)
```

App discovery is a coroutine. A shell pipeline (one `awk` pass over the `.desktop` files, then `sort`) is
started with `popen` before the window opens, and `scan_apps` reads it as if it
owned the thread, performing `Feed.found app` per entry and `Feed.pause` at each
frame boundary. It reads only after a zero-timeout `poll(2)` says the pipe is
ready, so no frame ever blocks on it. The handler stores the paused continuation
in the model, each frame resumes it with `@true`, and quitting resumes it with
`@false` so its own `@finale` around the read loop reaps the child.

Regenerate the bindings after a raylib upgrade:

```
LIB=bin/libraylib.so MOD=RAYLIB OUT=RAYLIB.ares \
  ares run ../cbindgen/MAIN.ares <path-to>/raylib.h
```

## Run it

From the repo, build the `ares` binary once:

```
nix develop -c cargo build -p ares     # produces target/debug/ares
```

Then, from **this directory**:

```
nix develop            # links bin/libraylib.so and library/ into place
ares run MAIN.ares     # or: ../../target/debug/ares run MAIN.ares
```

`nix develop`'s shell hook symlinks `bin/libraylib.so` (the library the
`@extern` paths name) and `library/` (the Ares standard library the interpreter
resolves `CORE` from), so this directory is self-contained.

### Build a native binary instead

The C backend emits a real `typedef struct { ... } Color;` and passes it by
value, so the compiled program uses the platform ABI directly:

```
ares build MAIN.ares   # emits MAIN.c, compiles and links -> ./MAIN
./MAIN
```

## Edit the app list

The fallback programs (used when no desktop entries are found) are a plain
vector near the top of `MAIN.ares`, built with the `app` helper (label, command,
whether it needs a terminal):

```
$ fallback_apps : @Vec App =
	[ app "Terminal" "xterm"      @false
	, app "Files"    "xdg-open ." @false
	, app "Browser"  "firefox"    @false ]
```
