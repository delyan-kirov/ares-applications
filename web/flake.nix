{
  description = "Ares web playground: the compiler built to wasm32-unknown-unknown, run in the browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      # Self-contained toolchain for the web deliverable, so the main compiler
      # flake does not have to carry it. The playground is a member of the
      # `applications` workspace and reaches the compiler crates by relative path,
      # so build it from the workspace root (the parent of this directory).
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          # rustc/cargo build the `playground` crate to wasm32-unknown-unknown
          # (nixpkgs rustc ships that target's std). `lld` provides the `wasm-ld`
          # linker named by ../.cargo/config.toml; `gcc` links the host build
          # scripts. `nodejs` runs the build, the site server and the headless
          # smoke test, all TypeScript it runs directly. `typescript` (tsc)
          # type-checks the page's sources (src/) and emits the JavaScript the
          # browser loads; nothing from npm reaches the page. `libffi` is for
          # the playground's native tests (`cargo test -p playground`), which
          # build the interpreter for the host, where `@extern` needs it.
          # `ffmpeg` scales the icon FAVICON.ares renders down to its PNG sizes.
          pkgs.rustc
          pkgs.cargo
          pkgs.lld
          pkgs.gcc
          pkgs.nodejs
          pkgs.typescript
          pkgs.git
          pkgs.libffi
          pkgs.ffmpeg-headless
        ];

        shellHook = ''
          # Read by crates/interpreter/build.rs to link libffi for `@extern`.
          export LIBFFI=${pkgs.libffi.out}
          export LIBFFI_DEV=${pkgs.libffi.dev}
          echo "web playground shell. From the applications workspace root (..):"
          echo "    node web/build.ts       # build the wasm, cells and scripts, then smoke-test"
          echo "    node web/serve.ts       # serve http://localhost:8000"
          echo ""
          echo "site/playground.wasm is checked in: rebuild it after any change to"
          echo "crates/ or library/, or the site keeps running the older compiler."
        '';
      };
    };
}
