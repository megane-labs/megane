// @vitest-environment node
/**
 * Corrupt trajectory headers against the real WASM module. The browser parser
 * runs on wasm32, where `usize` is 32 bits: a size field near `u32::MAX`
 * (an XTC byte count, a NetCDF string length, a DCD record size) or an atom
 * count whose byte size passes 2^32 wraps unchecked arithmetic and panics
 * (a `RuntimeError: unreachable` trap) instead of reporting the bad file.
 * Each must fail as an ordinary parse error. The 64-bit native build cannot
 * overflow there, so these cases are only reachable through the WASM build.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ensureInit, parseTrajectoryCore, type TrajectoryParseInput } from "@/parsers/parseCore";

const ROOT = process.cwd();

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
});

/** Big- or little-endian 32-bit words, as bytes. */
function words(values: number[], littleEndian = false): number[] {
  const view = new DataView(new ArrayBuffer(4 * values.length));
  values.forEach((v, i) => view.setUint32(4 * i, v >>> 0, littleEndian));
  return [...new Uint8Array(view.buffer)];
}

const f32be = (v: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, v);
  return [...new Uint8Array(view.buffer)];
};

/** The parse throws a parser error, not a WASM trap. */
function expectParseError(input: TrajectoryParseInput, message: RegExp) {
  let error: unknown;
  try {
    parseTrajectoryCore(input);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(WebAssembly.RuntimeError);
  expect((error as Error).message).toMatch(message);
}

/** A netCDF classic name: length word, bytes, padding. */
function ncName(name: string): number[] {
  const bytes = [...new TextEncoder().encode(name)];
  while (bytes.length % 4 !== 0) bytes.push(0);
  return [...words([name.length]), ...bytes];
}

describe("trajectory headers with sizes that overflow wasm32", () => {
  it("XTC: a compressed block byte count near 2^32", () => {
    // natoms 10 (compressed), a valid 1-integer range and smallidx 9.
    const bytes = Uint8Array.from([
      ...words([1995, 10, 0]),
      ...f32be(0),
      ...Array.from({ length: 9 }, () => f32be(3)).flat(),
      ...words([10]),
      ...f32be(1000),
      ...words([0, 0, 0, 0, 0, 0, 9, 0xffff_fffe]),
      ...words([0, 0]),
    ]);
    expectParseError({ kind: "xtc", bytes, expectedNAtoms: 10 }, /XTC|opaque|too large/);
  });

  it("NetCDF: a dimension name length near 2^32", () => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("CDF\x01"),
      ...words([1, 10, 1, 0xffff_fffe, 0, 0]),
    ]);
    expectParseError({ kind: "netcdf", bytes, expectedNAtoms: 1 }, /NetCDF|string/);
  });

  it("NetCDF: an atom dimension whose coordinate size passes 2^32", () => {
    // atom = 0x15555556: n_atoms * 12 wraps to 8 on wasm32, which a vsize of
    // 8 would then match.
    const header = (begin: number) => [
      ...new TextEncoder().encode("CDF\x01"),
      ...words([1, 10, 3]),
      ...ncName("frame"),
      ...words([0]),
      ...ncName("atom"),
      ...words([0x1555_5556]),
      ...ncName("spatial"),
      ...words([3, 0, 0, 11, 1]),
      ...ncName("coordinates"),
      ...words([3, 0, 1, 2, 0, 0, 5, 8, begin]),
    ];
    const begin = header(0).length;
    const bytes = Uint8Array.from([...header(begin), ...new Array(8).fill(0)]);
    expectParseError({ kind: "netcdf", bytes, expectedNAtoms: 1 }, /atom/);
  });

  /** A little-endian CHARMM DCD header record (84 bytes) with NSET `nset`. */
  function dcdHeader(nset: number): number[] {
    const hdr = new DataView(new ArrayBuffer(84));
    [67, 79, 82, 68].forEach((c, i) => hdr.setUint8(i, c)); // "CORD"
    hdr.setInt32(4, nset, true);
    hdr.setInt32(12, 1, true);
    hdr.setInt32(80, 24, true); // CHARMM
    return [...words([84], true), ...new Uint8Array(hdr.buffer), ...words([84], true)];
  }

  it("DCD: a record size that wraps the end of the record before its start", () => {
    // The title record starts at byte 96; a size of 2^32 - 88 wraps its end
    // to byte 8, whose word (the header's NSET) is set to the same value so
    // the end marker would match.
    const size = 0x1_0000_0000 - 88;
    const bytes = Uint8Array.from([
      ...dcdHeader(size | 0),
      ...words([size], true),
      ...new Array(64).fill(0),
    ]);
    expectParseError({ kind: "dcd", bytes, expectedNAtoms: 1 }, /DCD/);
  });

  it("DCD: an atom count whose record size passes 2^32", () => {
    // NATOM = 0x40000001: n_atoms * 4 wraps to 4 on wasm32, so 4-byte
    // coordinate records would pass for it.
    const record = (payload: number[]) => [
      ...words([payload.length], true),
      ...payload,
      ...words([payload.length], true),
    ];
    const bytes = Uint8Array.from([
      ...dcdHeader(1),
      ...record(words([0], true)),
      ...record(words([0x4000_0001], true)),
      ...record(words([0], true)),
      ...record(words([0], true)),
      ...record(words([0], true)),
    ]);
    expectParseError({ kind: "dcd", bytes, expectedNAtoms: 1 }, /atom count/);
  });
});
