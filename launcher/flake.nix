{
  description = "Ares program launcher -- a raylib app using the C-struct FFI";

  # The Ares compiler, pinned from GitHub. `nix flake update ares` bumps it.
  inputs.ares.url = "github:delyan-kirov/Ares";
  # Ares's own nixpkgs, not a second pin. When the launcher runs on the
  # interpreter, `ares`, raylib, GLFW and the GL driver all share one process
  # and so one glibc, which must be at least as new as every library loaded into
  # it. One nixpkgs for all of them makes that hold by construction.
  inputs.nixpkgs.follows = "ares/nixpkgs";

  outputs =
    { self, nixpkgs, ares }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

      aresc = ares.packages.${system}.ares;
      font = "${pkgs.jetbrains-mono}/share/fonts/truetype/JetBrainsMono-Regular.ttf";

      # The GL driver comes from this flake's nixpkgs too, not the host's
      # /run/opengl-driver: that one is built against the host's glibc, and a host
      # newer than the pin cannot be loaded here (mesa then fails to load, EGL and
      # GLX both report no display, and GLFW crashes tearing the window down).
      # These point glvnd at the pinned mesa. Proprietary NVIDIA is not covered:
      # its userspace library has to match the running kernel module.
      mesaEnv = {
        __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
        __GLX_VENDOR_LIBRARY_NAME = "mesa";
        LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
        GBM_BACKENDS_PATH = "${pkgs.mesa}/lib/gbm";
      };
      mesaLib = "${pkgs.mesa}/lib";

      # Libraries the compiled binary loads: raylib (named by the `@extern`
      # paths) plus the GL/X stack raylib itself pulls in to open a window.
      graphicsLibs = [
        pkgs.raylib
        pkgs.libGL
        pkgs.libx11
        pkgs.libxcursor
        pkgs.libxi
        pkgs.libxinerama
        pkgs.libxrandr
      ];

      # Tools the launcher shells out to (popen/system): the desktop-file scan
      # (gawk), dedup/bounding (coreutils sort/timeout), the `?` web search
      # (xdg-open). Prepended to PATH so the user's own terminal and the apps it
      # launches still resolve from their environment.
      runtimeTools = pkgs.lib.makeBinPath [
        pkgs.gawk
        pkgs.coreutils
        pkgs.xdg-utils
      ];

      launcher = pkgs.stdenv.mkDerivation {
        pname = "ares-launcher";
        version = "0.1.0";
        src = self;

        nativeBuildInputs = [
          aresc
          pkgs.gcc
          pkgs.makeWrapper
        ];
        buildInputs = graphicsLibs;

        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR

          # Recreate the shell-linked deps the dev shell sets up (both gitignored,
          # so not in `src`): the standard library from the pinned compiler, and
          # the raylib the `@extern "bin/libraylib.so"` paths name (`ares build`
          # canonicalizes this symlink and bakes its store dir as an rpath, so the
          # binary finds raylib from anywhere).
          ln -sf ${ares}/library library
          mkdir -p bin
          ln -sf ${pkgs.raylib}/lib/libraylib.so bin/libraylib.so

          # `loadFontEx "bin/font.ttf"` is read at runtime; bake the store path so
          # the binary needs no working directory.
          substituteInPlace MAIN.ares --replace-fail '"bin/font.ttf"' '"${font}"'

          ares build MAIN.ares
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          install -Dm755 ares-out/MAIN $out/libexec/ares-launcher
          makeWrapper $out/libexec/ares-launcher $out/bin/ares-launcher \
            --prefix PATH : ${runtimeTools} \
            --prefix LD_LIBRARY_PATH : ${mesaLib} \
            ${pkgs.lib.concatStringsSep " " (
              pkgs.lib.mapAttrsToList (k: v: "--set ${k} ${v}") mesaEnv
            )}
          runHook postInstall
        '';

        meta = {
          description = "A raylib program launcher written in Ares";
          mainProgram = "ares-launcher";
        };
      };
    in
    {
      packages.${system} = {
        inherit launcher;
        default = launcher;
      };

      devShells.${system}.default = pkgs.mkShell (mesaEnv // {
        buildInputs = [
          pkgs.raylib # the library the launcher binds via @extern

          # Runtime deps of libraylib.so, so a window can open.
          pkgs.libGL
          pkgs.libx11
          pkgs.libxcursor
          pkgs.libxi
          pkgs.libxinerama
          pkgs.libxrandr

          # External tools the launcher shells out to (via popen/system):
          pkgs.gawk # the embedded desktop-file scan in `list_apps_cmd`
          pkgs.coreutils # sort (dedup the scan), timeout (bound `!` commands)
          pkgs.xdg-utils # xdg-open (the `?` web search)
        ];

        # Make this directory self-contained: `bin/libraylib.so` is the library
        # the `@extern` paths name (relative to here), and `library/` is the Ares
        # standard library the interpreter resolves `CORE` from. The `ares`
        # binary comes from the repo build (see README), whose dev shell uses the
        # same nixpkgs pin as long as `nix flake update ares` keeps up with it.
        # `-n` on the directory link: without it a second entry follows the
        # existing link and creates `library/library` inside the repo.
        shellHook = ''
          export RAYLIB=${pkgs.raylib}
          export LD_LIBRARY_PATH=${mesaLib}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
          mkdir -p bin
          ln -sf ${pkgs.raylib}/lib/libraylib.so bin/libraylib.so
          ln -sfn ../../library library
          # The UI font `loadFont "bin/font.ttf"` names, provided by nixpkgs so
          # the directory stays self-contained (like bin/libraylib.so).
          ln -sf ${pkgs.jetbrains-mono}/share/fonts/truetype/JetBrainsMono-Regular.ttf bin/font.ttf
          echo "launcher shell ready. Build ares once in the repo, then:"
          echo "    ares run MAIN.ares      # or: ../../target/debug/ares run MAIN.ares"
        '';
      });
    };
}
