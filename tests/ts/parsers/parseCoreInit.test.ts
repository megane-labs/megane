/**
 * `ensureInit` hands the WASM URL to wasm-bindgen's init as an options object.
 *
 * The init also accepts a bare URL, but then logs "using deprecated parameters
 * for the initialization function" — which the parse worker, the one caller
 * that always passes an explicit URL, would print on every page load.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { init, wasmMock } = vi.hoisted(() => {
  const init = vi.fn(async (_opts?: unknown) => {});
  // ensureInit captures every parser export; any stub will do for those.
  const parserExports = (
    "parse_pdb parse_gro parse_xyz parse_molden parse_xsf parse_c3xml parse_odydata " +
    "parse_cml parse_magres parse_gamess parse_phonon parse_vasp parse_mol parse_mol2 " +
    "parse_cif parse_mmcif parse_lammps_data parse_prmtop parse_traj " +
    "parse_lammpstrj_structure parse_xtc_file parse_dcd_file parse_netcdf_file " +
    "parse_lammpstrj_file parse_structure_prefix decode_trajectory_frame0 XtcDecoder " +
    "LammpstrjDecoder StructureFrameDecoder infer_bonds_vdw parse_top_bonds " +
    "parse_top_bonds_with_includes parse_psf_bonds parse_pdb_bonds extract_labels " +
    "write_structure"
  ).split(" ");
  const wasmMock: Record<string, unknown> = { default: init };
  for (const name of parserExports) wasmMock[name] = () => {};
  return { init, wasmMock };
});

vi.mock("../../../crates/megane-wasm/pkg", () => wasmMock);

async function freshCore() {
  vi.resetModules();
  return import("@/parsers/parseCore");
}

describe("ensureInit", () => {
  beforeEach(() => {
    init.mockClear();
    delete (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__;
  });

  it("passes an explicit URL (the worker's) as module_or_path", async () => {
    const core = await freshCore();
    await core.ensureInit("https://example.test/assets/megane_wasm_bg.wasm");
    expect(init).toHaveBeenCalledWith({
      module_or_path: "https://example.test/assets/megane_wasm_bg.wasm",
    });
  });

  it("falls back to the host's __MEGANE_WASM_URL__ override", async () => {
    (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__ = "vscode-resource:/megane.wasm";
    const core = await freshCore();
    await core.ensureInit();
    expect(init).toHaveBeenCalledWith({ module_or_path: "vscode-resource:/megane.wasm" });
  });

  it("leaves module_or_path undefined so the glue resolves its own asset", async () => {
    const core = await freshCore();
    await core.ensureInit();
    expect(init).toHaveBeenCalledWith({ module_or_path: undefined });
  });

  it("initialises once however many callers race", async () => {
    const core = await freshCore();
    await Promise.all([core.ensureInit(), core.ensureInit(), core.ensureInit()]);
    await core.ensureInit();
    expect(init).toHaveBeenCalledTimes(1);
  });
});
