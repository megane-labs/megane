# Emscripten build of megane's RDKit embedding wrapper.
#
# Configure with emcmake against an RDKit tree that scripts/build.sh has
# already compiled to WebAssembly static libraries:
#
#   emcmake cmake -S rdkit-wasm -B rdkit-wasm/build -G Ninja \
#     -DRDKIT_SOURCE_DIR=... -DRDKIT_BUILD_DIR=... \
#     -DBoost_DIR=... -Dboost_headers_DIR=...
#
# scripts/build.sh does all of this; the file is kept small so the flags are
# reviewable in one place.

cmake_minimum_required(VERSION 3.20)
project(rdkit_embed_wasm CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This project must be configured with emcmake (Emscripten toolchain).")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(RDKIT_SOURCE_DIR "" CACHE PATH "RDKit source checkout (contains Code/)")
set(RDKIT_BUILD_DIR "" CACHE PATH "RDKit Emscripten build tree (contains Code/**/libRDKit*_static.a)")
foreach(var RDKIT_SOURCE_DIR RDKIT_BUILD_DIR)
  if(NOT IS_DIRECTORY "${${var}}")
    message(FATAL_ERROR "${var} must point to a directory (got '${${var}}').")
  endif()
endforeach()

# Header-only use of Boost (property_tree for the options JSON).
find_package(Boost REQUIRED CONFIG)

# With RDK_INSTALL_INTREE=OFF each library is archived next to its sources
# (Code/GraphMol/DistGeomHelpers/libRDKitDistGeomHelpers_static.a, ...).
file(GLOB_RECURSE RDKIT_STATIC_LIBS "${RDKIT_BUILD_DIR}/Code/*_static.a" "${RDKIT_BUILD_DIR}/External/*_static.a")
list(LENGTH RDKIT_STATIC_LIBS n_libs)
if(n_libs EQUAL 0)
  message(FATAL_ERROR "No *_static.a under ${RDKIT_BUILD_DIR}; build RDKit first (scripts/build.sh rdkit).")
endif()
message(STATUS "Linking ${n_libs} RDKit static libraries from ${RDKIT_BUILD_DIR}")

add_executable(rdkit-embed src/rdkit_embed.cpp)
target_include_directories(rdkit-embed PRIVATE
  "${RDKIT_SOURCE_DIR}/Code"
  "${RDKIT_BUILD_DIR}/Code")
# wasm-ld resolves archive members lazily regardless of order, but listing the
# set twice keeps the link robust to any circular dependency between RDKit libs.
target_link_libraries(rdkit-embed PRIVATE Boost::headers ${RDKIT_STATIC_LIBS} ${RDKIT_STATIC_LIBS})

# Exceptions must use the same ABI as the RDKit libraries (-fwasm-exceptions).
target_compile_options(rdkit-embed PRIVATE -fwasm-exceptions -O3)

set(RDKIT_EMBED_LINK_FLAGS
  "-fwasm-exceptions"
  "-O3"
  "-lembind"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=createRDKitEmbedModule"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sMAXIMUM_MEMORY=4GB"
  "-sSTACK_SIZE=2MB"
  "-sENVIRONMENT=web,worker,node"
  "-sFILESYSTEM=0"
  "-sEXPORTED_RUNTIME_METHODS=[]"
)
list(JOIN RDKIT_EMBED_LINK_FLAGS " " RDKIT_EMBED_LINK_FLAGS_STR)
set_target_properties(rdkit-embed PROPERTIES
  OUTPUT_NAME "rdkit-embed"
  SUFFIX ".mjs"
  LINK_FLAGS "${RDKIT_EMBED_LINK_FLAGS_STR}")
