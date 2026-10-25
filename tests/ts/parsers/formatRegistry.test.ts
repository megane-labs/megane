// @vitest-environment node
/**
 * The WASM binding is generated from megane-core's format registry
 * (`crates/megane-core/src/formats.rs`), the same registry the PyO3 binding is
 * generated from — `tests/python/test_format_registry.py` is this file's
 * Python twin. Together they pin CRITICAL RULE #6 (host consistency): both
 * hosts expose exactly the registry's structure / trajectory formats, plus a
 * short, explicit allowlist of host-specific exports.
 *
 * This test loads the real compiled module (`npm run build:wasm`), reads the
 * registry it embeds, and checks it against (a) the module's own exports and
 * their declared return types and (b) the web app's extension tables.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as wasm from "../../../crates/megane-wasm/pkg/megane_wasm.js";
import { STRUCTURE_EXTS, TRAJECTORY_EXTS } from "@/parsers/fileNames";

const PKG = resolve(__dirname, "../../../crates/megane-wasm/pkg");

interface Registry {
  structure: { binding: string; encoding: "text" | "binary"; extensions: string[] }[];
  trajectory: {
    wasm: string;
    python: string;
    encoding: "text" | "binary";
    extensions: string[];
  }[];
}

/**
 * WASM-only exports that return a `ParseResult` but are not a format entry:
 * the first-paint helpers that parse frame 0 from part of a file — the
 * bounded-prefix reader for the lazily streamed XYZ / PDB, and the head-and-tail
 * reader for ASE `.traj` (Python reads whole files, so it has neither) — and
 * `parse_structure_bytes`, which dispatches any registry format by extension
 * from raw bytes so the parse worker never makes a JS string of the file.
 * Everything else returning `ParseResult` must come from the registry.
 */
const WASM_ONLY_STRUCTURE_EXPORTS = [
  "parse_structure_bytes",
  "parse_structure_prefix",
  "parse_traj_frame0",
];

let registry: Registry;
let declarations: string;

beforeAll(() => {
  wasm.initSync({ module: readFileSync(resolve(PKG, "megane_wasm_bg.wasm")) });
  registry = JSON.parse(wasm.format_registry()) as Registry;
  declarations = readFileSync(resolve(PKG, "megane_wasm.d.ts"), "utf8");
});

/** Names of the exported functions whose declared return type is `ret`. */
function exportsReturning(ret: string): string[] {
  const re = new RegExp(`^export function (\\w+)\\([^)]*\\): ${ret};`, "gm");
  return [...declarations.matchAll(re)].map((m) => m[1]).sort();
}

describe("WASM format registry", () => {
  it("exports one callable parser per registry structure format", () => {
    const exported = wasm as unknown as Record<string, unknown>;
    expect(registry.structure.length).toBeGreaterThan(15);
    for (const { binding } of registry.structure) {
      expect(typeof exported[binding], binding).toBe("function");
    }
  });

  it("returns ParseResult only from registry formats plus the allowlist", () => {
    const expected = [
      ...registry.structure.map((f) => f.binding),
      ...WASM_ONLY_STRUCTURE_EXPORTS,
    ].sort();
    expect(exportsReturning("ParseResult")).toEqual(expected);
  });

  it("returns XtcParseResult exactly from the registry trajectory formats", () => {
    const expected = registry.trajectory.map((f) => f.wasm).sort();
    expect(exportsReturning("XtcParseResult")).toEqual(expected);
  });

  it("parses raw bytes by extension the same as each text parser", () => {
    const pdb = readFileSync(resolve(__dirname, "../../fixtures/1crn.pdb"));
    const viaText = wasm.parse_pdb(pdb.toString("utf8"));
    const viaBytes = wasm.parse_structure_bytes(".pdb", new Uint8Array(pdb));
    expect(viaBytes.n_atoms).toBe(viaText.n_atoms);
    expect(Array.from(viaBytes.positions())).toEqual(Array.from(viaText.positions()));
    expect(viaBytes.atom_labels).toBe(viaText.atom_labels);
    // An unknown extension reads as PDB, like the browser's dispatch.
    expect(wasm.parse_structure_bytes(".unknown", new Uint8Array(pdb)).n_atoms).toBe(
      viaText.n_atoms,
    );
    const gro = readFileSync(resolve(__dirname, "../../fixtures/water.gro"), "utf8");
    expect(wasm.parse_structure_bytes("gro", new TextEncoder().encode(gro)).n_atoms).toBe(
      wasm.parse_gro(gro).n_atoms,
    );
    expect(() => wasm.parse_structure_bytes(".pdb", new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(
      /UTF-8/,
    );
  });

  it("carries signed Cα residue numbers (expression tags below 1)", () => {
    const pdb =
      "ATOM      1  CA  HIS A  -1       0.000   0.000   0.000  1.00  0.00           C\n" +
      "ATOM      2  CA  MET A   1       3.800   0.000   0.000  1.00  0.00           C\n" +
      "END\n";
    const resNums = wasm.parse_pdb(pdb).ca_res_nums();
    expect(resNums).toBeInstanceOf(Int32Array);
    expect(Array.from(resNums)).toEqual([-1, 1]);
  });

  it("declares each parser's argument with the registry encoding", () => {
    for (const { binding, encoding } of registry.structure) {
      const arg = encoding === "binary" ? "data: Uint8Array" : "text: string";
      expect(declarations, binding).toContain(`export function ${binding}(${arg}): ParseResult;`);
    }
    for (const { wasm: name, encoding } of registry.trajectory) {
      const arg = encoding === "binary" ? "data: Uint8Array" : "text: string";
      expect(declarations, name).toContain(`export function ${name}(${arg}): XtcParseResult;`);
    }
  });

  it("covers exactly the web app's structure and trajectory extension lists", () => {
    const structureExts = registry.structure.flatMap((f) => f.extensions).sort();
    const trajectoryExts = registry.trajectory.flatMap((f) => f.extensions).sort();
    expect(structureExts).toEqual([...STRUCTURE_EXTS].sort());
    expect(trajectoryExts).toEqual([...TRAJECTORY_EXTS].sort());
  });

  it("parses through a generated binding", () => {
    const text = readFileSync(resolve(__dirname, "../../fixtures/water.gro"), "utf8");
    const result = wasm.parse_gro(text);
    try {
      expect(result.n_atoms).toBeGreaterThan(0);
      expect(result.positions().length).toBe(result.n_atoms * 3);
    } finally {
      result.free();
    }
    expect(() => wasm.parse_gro("")).toThrow();
  });
});
