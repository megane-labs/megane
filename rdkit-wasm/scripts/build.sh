#!/usr/bin/env bash
# Build RDKit's ETKDG embedding for the browser as a WebAssembly module.
#
#   bash rdkit-wasm/scripts/build.sh            # everything: deps, rdkit, wrapper, test
#   bash rdkit-wasm/scripts/build.sh deps       # emsdk, Boost headers, zlib, Eigen, RDKit checkout
#   bash rdkit-wasm/scripts/build.sh rdkit      # RDKit static libraries (the slow step)
#   bash rdkit-wasm/scripts/build.sh wrapper    # the embind wrapper -> rdkit-wasm/dist/
#   bash rdkit-wasm/scripts/build.sh test       # node smoke test against dist/
#
# Everything downloaded or built lands under rdkit-wasm/.deps (override with
# RDKIT_WASM_DEPS_DIR) so a CI cache of that directory skips the RDKit build.
#
# Sources are fetched with `git clone` rather than release tarballs: sandboxed
# environments often allow git over HTTPS to github.com but block the
# codeload/archive download hosts (HTTP 403), and RDKit's own CMake downloads
# (RingDecomposerLib, coordgen, maeparser, ...) are switched off for the same
# reason. Boost has no git-friendly layout, so it comes from archives.boost.io.
#
# Pinned versions (override via environment):
#   RDKIT_TAG      RDKit git tag                  (default Release_2026_03_6)
#   BOOST_VERSION  Boost release, headers only    (default 1.87.0)
#   ZLIB_TAG       zlib git tag                   (default v1.3.1)
#   EIGEN_TAG      Eigen git tag, used only when  (default 3.4.0)
#                  /usr/include/eigen3 is absent
#   EMSDK_VERSION  Emscripten SDK release         (default 6.0.9)
#   JOBS           parallel compile jobs          (default: nproc)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="${RDKIT_WASM_DEPS_DIR:-$ROOT/.deps}"
RDKIT_TAG="${RDKIT_TAG:-Release_2026_03_6}"
BOOST_VERSION="${BOOST_VERSION:-1.87.0}"
ZLIB_TAG="${ZLIB_TAG:-v1.3.1}"
EIGEN_TAG="${EIGEN_TAG:-3.4.0}"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.9}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"
STEP="${1:-all}"

# Exceptions must use one ABI across zlib, RDKit and the wrapper.
EXC_FLAGS="-fwasm-exceptions"

EMSDK_DIR="$DEPS/emsdk"
BOOST_PREFIX="$DEPS/boost"
ZLIB_PREFIX="$DEPS/zlib"
RDKIT_SRC="$DEPS/rdkit"
RDKIT_BUILD="$DEPS/rdkit-build"
WRAPPER_BUILD="$ROOT/build"
DIST="$ROOT/dist"

log() { printf '\n==> %s\n' "$*"; }

generator_args() {
  if command -v ninja >/dev/null 2>&1; then echo "-G" "Ninja"; fi
}

activate_emsdk() {
  # shellcheck disable=SC1091
  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
  emcc --version | head -1
}

eigen_include_dir() {
  if [ -d /usr/include/eigen3 ]; then
    echo /usr/include/eigen3
  else
    echo "$DEPS/eigen"
  fi
}

step_deps() {
  mkdir -p "$DEPS"

  if [ ! -x "$EMSDK_DIR/emsdk" ]; then
    log "Cloning emsdk"
    git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
  fi
  if [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
    log "Installing Emscripten $EMSDK_VERSION"
    (cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
  fi
  activate_emsdk

  if [ ! -d "$BOOST_PREFIX/lib/cmake/boost_headers-$BOOST_VERSION" ]; then
    local underscore="${BOOST_VERSION//./_}"
    local tarball="$DEPS/boost_$underscore.tar.bz2"
    log "Fetching Boost $BOOST_VERSION (headers only)"
    [ -f "$tarball" ] || curl -sSfL --retry 3 -o "$tarball" \
      "https://archives.boost.io/release/$BOOST_VERSION/source/boost_$underscore.tar.bz2"
    rm -rf "$DEPS/boost_$underscore"
    tar xjf "$tarball" -C "$DEPS"
    # RDKit only needs Boost headers once serialization/iostreams are off;
    # `system` is the smallest library b2 accepts and yields the CMake config.
    (cd "$DEPS/boost_$underscore" && ./bootstrap.sh --prefix="$BOOST_PREFIX" --with-libraries=system >/dev/null \
      && ./b2 -j"$JOBS" install >/dev/null)
    rm -rf "$DEPS/boost_$underscore"
  fi

  if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    log "Building zlib $ZLIB_TAG for wasm (FileParsers' PNG reader needs it)"
    rm -rf "$DEPS/zlib-src" "$DEPS/zlib-build"
    git clone -q --depth 1 --branch "$ZLIB_TAG" https://github.com/madler/zlib.git "$DEPS/zlib-src"
    emcmake cmake -S "$DEPS/zlib-src" -B "$DEPS/zlib-build" $(generator_args) \
      -DCMAKE_BUILD_TYPE=Release -DZLIB_BUILD_EXAMPLES=OFF \
      -DCMAKE_C_FLAGS="$EXC_FLAGS -O3" -DCMAKE_INSTALL_PREFIX="$ZLIB_PREFIX" >/dev/null
    cmake --build "$DEPS/zlib-build" -j"$JOBS" --target install >/dev/null
  fi

  if [ ! -d /usr/include/eigen3 ] && [ ! -f "$DEPS/eigen/Eigen/Core" ]; then
    log "Cloning Eigen $EIGEN_TAG (header only)"
    git clone -q --depth 1 --branch "$EIGEN_TAG" https://gitlab.com/libeigen/eigen.git "$DEPS/eigen"
  fi

  if [ ! -d "$RDKIT_SRC/Code" ]; then
    log "Cloning RDKit $RDKIT_TAG"
    git clone -q --depth 1 --branch "$RDKIT_TAG" https://github.com/rdkit/rdkit.git "$RDKIT_SRC"
  fi
}

step_rdkit() {
  activate_emsdk
  log "Configuring RDKit ($RDKIT_TAG) for Emscripten"
  # Everything the embedding path does not need is off: no Python, tests,
  # drawing, InChI, coordgen/maeparser, 3D descriptors, threads, or the
  # optional externals RDKit would otherwise download at configure time.
  emcmake cmake -S "$RDKIT_SRC" -B "$RDKIT_BUILD" $(generator_args) \
    -DCMAKE_BUILD_TYPE=Release \
    -DRDK_BUILD_PYTHON_WRAPPERS=OFF -DRDK_BUILD_CPP_TESTS=OFF \
    -DRDK_INSTALL_INTREE=OFF -DRDK_INSTALL_STATIC_LIBS=ON \
    -DRDK_BUILD_INCHI_SUPPORT=OFF -DRDK_BUILD_AVALON_SUPPORT=OFF -DRDK_BUILD_SLN_SUPPORT=OFF \
    -DRDK_BUILD_THREADSAFE_SSS=OFF -DRDK_TEST_MULTITHREADED=OFF -DRDK_BUILD_DESCRIPTORS3D=OFF \
    -DRDK_BUILD_CHEMDRAW_SUPPORT=OFF -DRDK_BUILD_MAEPARSER_SUPPORT=OFF -DRDK_BUILD_COORDGEN_SUPPORT=OFF \
    -DRDK_BUILD_PUBCHEMSHAPE_SUPPORT=OFF -DRDK_BUILD_XYZ2MOL_SUPPORT=OFF \
    -DRDK_BUILD_FREETYPE_SUPPORT=OFF -DRDK_BUILD_CAIRO_SUPPORT=OFF \
    -DRDK_USE_BOOST_SERIALIZATION=OFF -DRDK_USE_BOOST_IOSTREAMS=OFF -DRDK_USE_BOOST_STACKTRACE=OFF \
    -DRDK_OPTIMIZE_POPCNT=OFF -DRDK_USE_URF=OFF \
    -DBoost_DIR="$BOOST_PREFIX/lib/cmake/Boost-$BOOST_VERSION" \
    -Dboost_headers_DIR="$BOOST_PREFIX/lib/cmake/boost_headers-$BOOST_VERSION" \
    -DEIGEN3_INCLUDE_DIR="$(eigen_include_dir)" \
    -DZLIB_INCLUDE_DIR="$ZLIB_PREFIX/include" -DZLIB_LIBRARY="$ZLIB_PREFIX/lib/libz.a" \
    -DCMAKE_CXX_FLAGS="$EXC_FLAGS -O3 -DNDEBUG" -DCMAKE_C_FLAGS="$EXC_FLAGS -O3 -DNDEBUG"

  log "Building the RDKit libraries the wrapper links (-j$JOBS)"
  # Only these four targets (and what they depend on) are built; the rest of
  # RDKit (drawing, fingerprints, reactions, ...) never gets compiled.
  cmake --build "$RDKIT_BUILD" -j"$JOBS" --target \
    DistGeomHelpers_static ForceFieldHelpers_static FileParsers_static SmilesParse_static
}

step_wrapper() {
  activate_emsdk
  log "Building the embind wrapper"
  emcmake cmake -S "$ROOT" -B "$WRAPPER_BUILD" $(generator_args) \
    -DCMAKE_BUILD_TYPE=Release \
    -DRDKIT_SOURCE_DIR="$RDKIT_SRC" -DRDKIT_BUILD_DIR="$RDKIT_BUILD" \
    -DBoost_DIR="$BOOST_PREFIX/lib/cmake/Boost-$BOOST_VERSION" \
    -Dboost_headers_DIR="$BOOST_PREFIX/lib/cmake/boost_headers-$BOOST_VERSION"
  cmake --build "$WRAPPER_BUILD" -j"$JOBS"
  mkdir -p "$DIST"
  cp "$WRAPPER_BUILD/rdkit-embed.mjs" "$WRAPPER_BUILD/rdkit-embed.wasm" "$DIST/"
  ls -la "$DIST"
}

step_test() {
  log "Smoke test"
  node "$ROOT/test/smoke.mjs"
}

case "$STEP" in
  deps) step_deps ;;
  rdkit) step_rdkit ;;
  wrapper) step_wrapper ;;
  test) step_test ;;
  all) step_deps; step_rdkit; step_wrapper; step_test ;;
  *) echo "Unknown step '$STEP' (deps | rdkit | wrapper | test | all)" >&2; exit 2 ;;
esac
