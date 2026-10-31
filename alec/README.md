# alec

A C compiler **written in Thrax**, run on the Thrax interpreter, that compiles
C11 (with the common GNU extensions) to **WebAssembly**, either memory model:
**wasm32** (ILP32) or **wasm64** (LP64, memory64). It writes the binary module
itself, with no assembler or linker underneath, and compiles its own C library
alongside every program.

```
thrax run MAIN.thx -- hello.c                # a.wasm, wasm32
thrax run MAIN.thx -- -m64 -o hello.wasm hello.c
node run.mjs hello.wasm arg1 arg2            # run it
```

`run.mjs` is the host: it instantiates the module, supplies the dozen system
calls the C library imports (`write`, `read`, `exit`, the arguments, files,
the clock) plus the libm functions wasm has no instruction for, and exits with
the program's status.

| option | |
| --- | --- |
| `-m32`, `-m64` (`--target wasm32\|wasm64`) | memory model, default wasm32 |
| `-o FILE` | output (default `a.wasm`) |
| `-E` | preprocess only |
| `-fsyntax-only`, `--dump-ast` | parse and type-check; print the typed tree |
| `--dump-tokens`, `--dump-tokens=pp` | print the tokens as lexed, or as the parser sees them after preprocessing |
| `--dump-wasm` | print the module as text (given `.wasm` files, print those) |
| `--shell` | an interactive C shell (below) |
| `-I DIR`, `-D NAME[=V]`, `-U NAME` | as in cc |
| `-nostdlib` | do not link alec's C library (the entry is then `main`) |
| `-w`, `-v` | no warnings; report library files loaded and phase times |
| `--index-libc` | rebuild `libc/INDEX` and the library caches |

Several `.c` files compile into one module, each its own translation unit.

## The shell

`alec --shell` (`thrax-out/MAIN --shell` when built natively) is an
interactive C shell in the manner of `thrax repl`. Each entry is C:

```
c> int sq(int x) { return x * x; }
c> sq(7)
  // 49 : int
c> 1.0 / 3
  // 0.3333333333333333 : double
c> for (int i = 0; i < 3; i++) printf("%d ", i);
0 1 2 c> :type sq
sq : int (int)
```

A declaration (a directive, or an entry that starts with a type) joins the
session. Statements ending in `;` or `}` run once as the body of `main`, and
anything else is an expression, run once with its value printed on a `//`
line with its type, so a transcript pastes back as C. An entry continues over
lines while a bracket is open, and every entry sees `<stdio.h>`. Statements
are not replayed, so globals start afresh with each entry. `:tokens [pp]`,
`:ast` and `:wasm` show an entry's tokens, typed tree and code (`:wasm all`
the whole module), `:target` switches between wasm32 and wasm64, and `:help`
lists the rest. Each entry is compiled, linked and run under node, so it takes
about half a second natively.

## The design: effects all the way down

Every stage is written against algebraic effects, and `source/DRIVER.thx` is the one
place that decides what those effects mean. Nothing threads state by hand.

**Lexing** (`LEX`) is a pure function from source text to a lazy `List Token`.
A file streams through the pipeline one cell at a time and is never held as a
token vector. A malformed token is a `Bad` token, reported only if the
preprocessor actually uses it, so a broken line inside `#if 0` stays harmless.

**Preprocessing** (`PP`) runs against four effects:

| effect | |
| --- | --- |
| `Macros` | `find`/`define`/`undef`/`push_macro`/`pop_macro`: the macro table is a handler's state |
| `Files` | include resolution, the preprocessor's only contact with the world |
| `Out` | `emit` one output token |
| `Diag` | errors and warnings, for every stage |

Expansion is Prosser's algorithm: every token carries a hide set. An expansion
is lazily prepended to the rest of the input `List`, so rescanning it is just
continuing the loop. `#line` relocates the rest of a file with a lazy
`LIST.map`. `#if` expressions are evaluated under a small cursor effect of
their own, so an unevaluated `&&`/`||`/`?:` arm cannot raise an error.

**The pipe.** The preprocessor runs as a coroutine: `PARSE.start` handles
`Out.emit` by suspending it into a `Pull` value holding the rest of the
preprocessor. The parser's `Tok` handler is the consumer end. When the parser
needs a token, the handler resumes the preprocessor, which runs (expanding
macros and reading includes) until its next `emit`. A translation unit flows
from the bytes of the file to the grammar one token at a time, and the include
`Files` effect performed deep inside the suspended preprocessor still reaches
the driver's handler, because the coroutine runs under it.

**Parsing and typing** (`PARSE`) is one pass, in the shape of chibicc: every
node is built already typed, with C's conversions applied (decay, the usual
arithmetic conversions, pointer arithmetic scaled to bytes), so no semantic
pass follows. Its effects:

| effect | |
| --- | --- |
| `Tok` | `peek n` and `next`, the consumer end of the pipe |
| `Scope` | nested scopes for identifiers and tags. Whether `T` starts a declaration (the typedef-name problem) is a `lookup` |
| `Tab` | the struct/union layout table, fresh ids, the target |
| `Unit` | what the translation unit defines: globals, functions, prototypes, the current function's locals |

A declarator is read once, left to right, as a list of derivations
(`(*a)[3]` is pointer, then array), and its type is a right fold. The nested
form needs no re-parse. An unbraced aggregate initializer is only recognized
after its first expression turned out not to be the whole aggregate, and the
token stream cannot rewind, so that expression is handed down as pending
rather than re-read.

**Code generation** (`GEN`) maps C expressions onto the wasm operand stack,
under:

| effect | |
| --- | --- |
| `Code` | `emit` bytes |
| `Fr` | the frame: fresh wasm locals, each C local's slot, shadow-stack space, and the stack of enclosing wasm blocks, from which every branch depth is computed |
| `Types` | the module's signature table, deduplicated |
| `Bail` | "this function does not fit structured control flow" |

`switch` becomes nested blocks with a `br_table` (or a compare chain when the
cases are sparse). A `goto` to a label in an enclosing block is a dispatch
loop. Anything that does not fit (Duff's device, a `goto` into a nested block,
GNU computed `goto`) raises `Bail.unstructured`. `gen_func` handles it by
**flattening** the whole function, turning every `if`, loop and `switch` into
labelled segments and conditional jumps, and generating again. The common case
stays structured, and the unusual one still compiles.

**Linking** (`LINK`) merges the units, keeps what is reachable from the entry
point (so the C library costs only what a program uses), lays out data, then
the shadow stack, then the heap, and assembles the module (`WASM`). A function
that is declared but defined nowhere becomes an import from the host's `env`
module: a C prototype is all the FFI there is. The module carries a `name`
section, so a trap's stack trace in node reads as C.

### Values and the ABI

Integers up to 4 bytes are `i32`, 8-byte ones `i64`, `float` `f32`, `double`
and `long double` `f64`. Pointers are `i32` on wasm32 and `i64` on wasm64.
Locals live in wasm locals unless their address is taken or they are
aggregates, which go in a shadow-stack frame. A struct argument is passed as
the address of a copy, a struct result through a hidden pointer, and variadic
arguments through a hidden pointer to 8-byte slots. A function pointer is a
table index.

## The C library

`libc/` is C compiled by alec, with headers in `include/`: the C11 hosted
headers (`stdio`, `stdlib`, `string`, `ctype`, `math`, `time`, `stdint`,
`inttypes`, `limits`, `float`, `stdarg`, `stdbool`, `stddef`, `assert`,
`errno`, `signal`, `locale`, `wchar`, `stdatomic`, `stdalign`,
`stdnoreturn`, `iso646`), plus `unistd`, `fcntl`, `alloca`, and a
single-threaded `pthread`. It has a full `printf`/`scanf` family, buffered
`FILE` streams over host descriptors, a size-class `malloc`, `qsort`,
`strtod`, and time conversion. `memcpy`/`memset` are wasm bulk-memory
instructions, and `sqrt`, `floor` and friends are float instructions; the
transcendental functions are host imports.

A library file is parsed only when a program needs one of its symbols:
`libc/INDEX` maps each exported name to its file, and loading repeats until
nothing undefined is left.

## Testing

```
thrax run TEST.thx                          # tests/run/*.c, both targets
thrax run TEST.thx -- NAME...               # some of them
thrax run TEST.thx -- --regen               # re-record expectations with gcc
thrax run TEST.thx -- --suite DIR           # an external suite (c-testsuite layout)
```

Each `tests/run/NAME.c` is checked differentially: its expected stdout and
exit status are what **gcc** produces (`NAME.expected`, fed `NAME.input` when
present), and alec must match on wasm32 and wasm64. The runner parses the C
library once per target and shares it across tests.

Results at the time of writing:

| suite | result |
| --- | --- |
| `tests/run` (23 programs) | 46/46 |
| [c-testsuite](https://github.com/c-testsuite/c-testsuite), single-exec | 438/440 |
| [chibicc](https://github.com/rui314/chibicc)'s `test/`, wasm64 | 27/41; the rest are listed below |
| [c4](https://github.com/rswier/c4) compiled by alec | runs `hello.c`; on wasm64 it self-hosts three levels deep (c4 running c4 running c4 running hello) |

The c-testsuite miss is `_Generic` matching on `const` inside a pointer type
(00219, both targets): alec parses type qualifiers but does not keep them in
types. The chibicc misses are inline assembly; programs that call
`int (*)(void *)` through `void *(*)(void *)` (a signature mismatch that traps
in wasm); stack-layout and out-of-range-conversion undefined behaviour;
chibicc-internal names (`__va_area__`); spellings gcc also rejects (`100f`,
`signed char signed`); two expectations where chibicc and gcc disagree and
alec agrees with gcc (`#line`, `&array - 3`); a test that includes itself by
a path relative to chibicc's checkout; and label addresses stored in `static`
arrays.

## Limits

- Type qualifiers (`const`, `volatile`, `restrict`, `_Atomic`) are parsed and
  ignored, so `_Generic` cannot tell `int *` from `const int *`.
- `long double` is `double`. No `_Complex`, no `__int128`.
- `setjmp`/`longjmp` are absent (wasm has no stack switching to build them on).
- Threads run to completion at `pthread_create`, a legal schedule for programs
  that join their threads, but nothing runs concurrently.
- Statement expressions are flattened like functions, but a `break` from
  inside one to a loop outside it, in a function that also needs flattening,
  is not supported.

## Performance

alec is slow by compiler standards. Built natively (`thrax build MAIN.thx`,
then `thrax-out/MAIN`), lexing and preprocessing cost about 40 µs a token and
parsing about 120; on the interpreter, several times that.

The C library is therefore parsed once, not per compile. Each target's parsed
library units are kept in `libc/wasm32.cache` and `libc/wasm64.cache`
(`source/CACHE.thx`), stamped with a checksum of the library sources, alec's headers
and alec's own `.thx` files. A compile whose stamp does not match parses the
library afresh and rewrites the cache; `--index-libc` rebuilds both. Reading
a unit back skips its function bodies, which are decoded only for the
functions the program reaches, so a native hello world takes about 1.5 s.
The library is parsed in a world of its own: only alec's headers, and none of
the command line's `-I`, `-D` or `-U`.

## Files

| | |
| --- | --- |
| `BUILD.thx` | puts `source/` on the module search for every entry point |
| `MAIN.thx` | the command-line entry |
| `source/DRIVER.thx` | options and the handlers: files, macros, diagnostics, library loading |
| `source/LEX.thx` | the preprocessing-token lexer |
| `source/LIT.thx` | integer, float, character and string literal decoding |
| `source/PP.thx` | the preprocessor |
| `source/PARSE.thx` | the parser and type checker, with its handlers and the pipe |
| `source/TYPE.thx`, `source/AST.thx` | C types and layout; the typed tree |
| `source/GEN.thx` | code generation, including the flattening fallback |
| `source/LINK.thx` | linking, layout, imports |
| `source/CACHE.thx` | the parsed C library, saved and read back |
| `source/SHELL.thx` | `--shell` |
| `source/WAT.thx` | a module as text, for `--dump-wasm` and `:wasm` |
| `source/WASM.thx` | the binary format |
| `source/CFG.thx` | targets and predefined macros |
| `source/DIAG.thx` | the diagnostics effect |
| `source/DUMP.thx` | `--dump-ast`, `--dump-tokens` |
| `TEST.thx` | the differential test runner |
| `BENCH.thx` | phase timings |
| `run.mjs` | the node host |
| `include/`, `libc/` | the C library |
| `tests/run/` | the test programs and their recorded expectations |

## Thrax issues found while writing it

#304 (an effect inside a lazy constructor slot escapes its handler), #305
(a curried two-argument state handler clause is rejected), #306 (documented
import forms fail), #307 (`thrax run` eats the program's `--target=`), #308
(`@cast` target not propagated), #309 (bitwise intrinsics), #310 (record
update on an unforced lazy value), #311 (types through a non-imported module),
#312 (the dead `ext` keyword). The standard library gained `BITS` and `LIST`,
`C.fwrite`/`C.clock`, a binary-safe `IO.write_file`, and fixes to `to_string`
of the minimum `@Int`, `VEC.from_list` order, and a native `STR.cmp_str`.
