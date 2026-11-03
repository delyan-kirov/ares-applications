# zalmoxis

A line counter **written in Thrax**, in the manner of
[tokei](https://github.com/XAMPPRocky/tokei): for every language in a tree, how
many files, lines, lines of code, comment lines and blank lines it holds. The
name is the Thracian god's, as tokei's is a Japanese word.

```
thrax check TEST.thx            # the test suite: the checks run at compile time
thrax build MAIN.thx            # a native binary, thrax-out/MAIN
thrax-out/MAIN [-f] [-e GLOB]... [PATH]...
thrax run MAIN.thx -- PATH      # the same on the interpreter (much slower)
```

With no `PATH` it counts the current directory. `-e`/`--exclude` adds a
gitignore pattern that applies under every root, and `-f`/`--files` lists each
file under its language.

## What counts as what

Each line is one of three things, by the rules tokei uses:

- **code**: anything outside a comment. A string is code, so a comment
  opener inside a string is code, and every line of a multi-line string
  (a Python docstring included) is code.
- **comment**: a line holding only comments. A line inside a block comment is
  a comment even when blank, and a line that *starts* inside one is a comment
  whatever follows the close.
- **blank**: only whitespace.

A backslash escapes the next byte, in a string and out of one (so the quote in
`'\"'` opens no string). Block comments nest where the language's do (Rust,
Haskell, Swift, Thrax, ...). Markdown, plain text and reStructuredText are
prose: every non-blank line is a comment. An empty Rust doc comment (`///`) is
blank.

The walk also follows tokei's defaults. Symbolic links are not followed, and the
`.gitignore` and `.ignore` of every directory apply below it, with a later or
deeper rule winning. Hidden entries are skipped unless a rule whitelists them
(`!/.github/`). A file is matched by exact name (`Makefile`), then by extension,
compared in lowercase, then, when it has no extension, by its `#!` line.

## Where it differs from tokei

Per file, it agrees with tokei across the Thrax repository, a raylib checkout
and nixpkgs, except here:

- Tokei counts code embedded in another language as a child of it (CSS in a
  `<style>`, a code block in Markdown, the Markdown of a Rust doc comment).
  zalmoxis counts it all as the enclosing language. Tokei's children also drop
  lines (a Rust file with doc comments can come out a few lines short of
  `wc -l`); zalmoxis's line counts are exact.
- `.y` is Yacc (tokei: Happy), and `.inc` is not counted (tokei: Bitbake).
- `#! /bin/sh`, with a space, is recognized.
- Thrax (`.thx`) is a language here.

## Speed

Wall time against tokei 15.0 (best of 15, 12 threads, warm cache):

| tree | files | tokei | zalmoxis |
| --- | ---: | ---: | ---: |
| raylib | 894 | 34 ms | 43 ms |
| Thrax repository | 940 | 12 ms | 16 ms |
| nixpkgs | 48,500 | 355 ms | 830 ms |
| one 4 MB C file | 1 | 22 ms | 20 ms |
| one 16 MB Nix file | 1 | 80 ms | 115 ms |

How it gets there:

- **Reading**: `IO.read_file` sizes the file with `lseek`, reads it with one
  `C.read` into `malloc` memory, and copies that into a string with
  `@ptr_bytes`.
- **Scanning**: `@array_scan` jumps to the next byte that could open a comment
  or a string, so a plain line costs two scans. The scanner is one
  self-recursive function over unboxed integers, which the native backend
  turns into a C loop.
- **Parallel walk**: the walk is a parallel fold. Directories near the top are
  tasks, a large directory's files are handed out in chunks, and a file over
  128 KB gets a task of its own. Every task copies the ignore rules it
  inherits, because a value shared between tasks is counted atomically on
  every read. The syntax tables are a global, which is immortal once the pool
  runs and so costs no counting at all.

## Layout

| | |
| --- | --- |
| `MAIN.thx` | arguments, the counting fold, the report |
| `COUNT.thx` | the line scanner |
| `LANGS.thx` | the language table and file detection |
| `WALK.thx` | the parallel walk and gitignore rules |
| `TEST.thx` | the checks |
