/**
 * Unit tests for the synchronous parse client and the parseCore dispatch layer.
 *
 * The real WASM module is replaced with a mock (jsdom cannot run the wasm-bindgen
 * bundle), so these exercise the full main-thread path: File read → ensureInit →
 * format dispatch (getParserForExtension / parseTrajectoryCore) → result
 * extraction. This is the coverage that the worker/E2E paths cannot provide in a
 * unit environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Everything the vi.mock factory touches must be created inside vi.hoisted(),
// because vi.mock is hoisted above the module body (and above these helpers).
const { calls, wasmMock } = vi.hoisted(() => {
  const calls: string[] = [];

  function mockStructResult(nAtoms: number, nFrames = 0) {
    return {
      n_atoms: nAtoms,
      n_bonds: 0,
      n_file_bonds: 0,
      n_frames: nFrames,
      has_box: false,
      has_atom_labels: false,
      has_chain_ids: false,
      has_bfactors: false,
      atom_labels: "",
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      ca_count: 0,
      symmetry_op_count: 0,
      symmetry_ops: "",
      positions: () => new Float32Array(nAtoms * 3),
      elements: () => new Uint8Array(nAtoms),
      bonds: () => new Uint32Array(0),
      bond_orders: () => new Uint8Array(0),
      box_matrix: () => new Float32Array(9),
      frame_data: () => new Float32Array(nFrames * nAtoms * 3),
      chain_ids: () => new Uint8Array(nAtoms),
      bfactors: () => new Float32Array(nAtoms),
      vector_channel_data: () => new Float32Array(),
      ca_indices: () => new Uint32Array(0),
      ca_chain_ids: () => new Uint8Array(0),
      ca_res_nums: () => new Uint32Array(0),
      ca_ss_type: () => new Uint8Array(0),
      free: () => {},
    };
  }

  function mockXtcResult(nAtoms: number, nFrames: number) {
    return {
      n_atoms: nAtoms,
      n_frames: nFrames,
      timestep_ps: 1,
      has_box: false,
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      box_matrix: () => new Float32Array(9),
      frame_data: () => new Float32Array(nFrames * nAtoms * 3),
      vector_channel_data: () => new Float32Array(),
      free: () => {},
    };
  }

  const structFn = (name: string) => () => {
    calls.push(name);
    return mockStructResult(3);
  };
  const xtcFn = (name: string) => () => {
    calls.push(name);
    return mockXtcResult(4, 2);
  };

  const wasmMock = {
    default: async () => {},
    parse_pdb: structFn("parse_pdb"),
    parse_gro: structFn("parse_gro"),
    parse_xyz: structFn("parse_xyz"),
    parse_molden: structFn("parse_molden"),
    parse_xsf: structFn("parse_xsf"),
    parse_c3xml: structFn("parse_c3xml"),
    parse_odydata: structFn("parse_odydata"),
    parse_cml: structFn("parse_cml"),
    parse_magres: structFn("parse_magres"),
    parse_gamess: structFn("parse_gamess"),
    parse_phonon: structFn("parse_phonon"),
    parse_vasp: structFn("parse_vasp"),
    parse_structure_prefix: structFn("parse_structure_prefix"),
    decode_trajectory_frame0: () => new Float32Array(4 * 3),
    parse_mol: structFn("parse_mol"),
    parse_mol2: structFn("parse_mol2"),
    parse_cif: structFn("parse_cif"),
    parse_mmcif: structFn("parse_mmcif"),
    parse_lammps_data: structFn("parse_lammps_data"),
    parse_prmtop: structFn("parse_prmtop"),
    parse_traj: () => {
      calls.push("parse_traj");
      return mockStructResult(3, 1);
    },
    parse_lammpstrj_structure: () => {
      calls.push("parse_lammpstrj_structure");
      return mockStructResult(3, 1);
    },
    parse_xtc_file: xtcFn("parse_xtc_file"),
    parse_dcd_file: xtcFn("parse_dcd_file"),
    parse_netcdf_file: xtcFn("parse_netcdf_file"),
    parse_lammpstrj_file: xtcFn("parse_lammpstrj_file"),
    infer_bonds_vdw: () => new Uint32Array([0, 1]),
    parse_top_bonds: () => new Uint32Array([0, 1]),
    parse_top_bonds_with_includes: () => new Uint32Array([0, 1]),
    parse_psf_bonds: () => new Uint32Array([0, 1]),
    parse_pdb_bonds: () => new Uint32Array([0, 1]),
    extract_labels: () => "A\nB\nC",
    write_structure: () => "1\n\nC 0 0 0\n",
    XtcDecoder: class {
      n_atoms = 4;
      n_frames = 2;
      timestep_ps = 1;
      has_box = false;
      box_matrix() {
        return new Float32Array(9);
      }
      times() {
        return new Float32Array(2);
      }
      decode_frame() {
        return new Float32Array(4 * 3);
      }
      free() {}
    },
    LammpstrjDecoder: class {
      n_atoms = 4;
      n_frames = 2;
      timestep_ps = 1;
      has_box = false;
      vector_channel_count = 0;
      vector_channel_names = "";
      heterogeneous = false;
      box_matrix() {
        return new Float32Array(9);
      }
      decode_frame() {
        return new Float32Array(4 * 3);
      }
      decode_frame_vectors() {
        return new Float32Array(0);
      }
      free() {}
    },
    StructureFrameDecoder: class {
      n_atoms = 3;
      n_frames = 2;
      heterogeneous = true;
      frame0() {
        return mockStructResult(3, 0);
      }
      decode_frame() {
        return new Float32Array(3 * 3);
      }
      free() {}
    },
  };

  return { calls, wasmMock };
});

vi.mock("../../../crates/megane-wasm/pkg", () => wasmMock);

import * as sync from "@/parsers/parseClientSync";

function fakeFile(name: string, content = "DATA"): File {
  return {
    name,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as unknown as File;
}

describe("parseClientSync (main-thread path with mocked wasm)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("dispatches structure formats by extension", async () => {
    const out = await sync.parseStructureFile(fakeFile("x.gro"));
    expect(out.snapshot.nAtoms).toBe(3);
    expect(calls).toContain("parse_gro");
  });

  it("routes .traj through the binary structure parser", async () => {
    const out = await sync.parseStructureFile(fakeFile("m.traj"));
    expect(calls).toContain("parse_traj");
    expect(out.frames.length).toBe(1); // one extra frame
  });

  it.each([["dump.lammpstrj"], ["run.dump"], ["md.trj"]])(
    "routes a LAMMPS dump (%s) through the standalone structure parser",
    async (filename) => {
      const out = await sync.parseStructureFile(fakeFile(filename, "ITEM: TIMESTEP"));
      expect(calls).toContain("parse_lammpstrj_structure");
      expect(out.frames.length).toBe(1); // frame 0 is the snapshot; one extra frame
    },
  );

  it.each([["si.xsf"], ["relax.axsf"]])(
    "routes the XCrySDen file %s through the XSF parser",
    async (filename) => {
      await sync.parseStructureFile(fakeFile(filename, "ATOMS\n 14 0 0 0\n"));
      expect(calls).toContain("parse_xsf");
    },
  );

  it("routes a .cml file through the CML parser", async () => {
    await sync.parseStructureFile(fakeFile("ethanol.cml", "<molecule/>"));
    expect(calls).toContain("parse_cml");
  });
  it.each([["POSCAR"], ["CONTCAR"], ["XDATCAR"], ["MgO.vasp"]])(
    "routes the VASP file %s through the VASP structure parser",
    async (filename) => {
      await sync.parseStructureFile(fakeFile(filename, "Si\n 1.0\n"));
      expect(calls).toContain("parse_vasp");
    },
  );

  it("routes a .jxyz file through the XYZ parser (Jmol's second extension)", async () => {
    await sync.parseStructureFile(fakeFile("benzene.jxyz", "1\ncomment\nC 0 0 0\n"));
    expect(calls).toContain("parse_xyz");
  });

  it("routes a Molden file through the Molden parser", async () => {
    await sync.parseStructureFile(
      fakeFile("water.molden", "[Molden Format]\n[Atoms] (Angs)\n O 1 8 0.0 0.0 0.0\n"),
    );
    expect(calls).toContain("parse_molden");
  });

  it("routes a Chem3D XML file through the Chem3D XML parser", async () => {
    await sync.parseStructureFile(
      fakeFile(
        "molecule.c3xml",
        '<CDXML><fragment><n id="1" Element="6" Position="0 0 0"/></fragment></CDXML>',
      ),
    );
    expect(calls).toContain("parse_c3xml");
  });

  it("routes an Odyssey XML file through the Odyssey parser", async () => {
    await sync.parseStructureFile(
      fakeFile(
        "sample.xodydata",
        '<odyssey_simulation><structure><atom id="1" element="C" xyz="0 0 0"/></structure></odyssey_simulation>',
      ),
    );
    expect(calls).toContain("parse_odydata");
  });

  it("routes an Odyssey text file through the same Odyssey parser", async () => {
    await sync.parseStructureFile(
      fakeFile("sample.odydata", " title\n0 1\n6 0.0 0.0 0.0\nENDCART\n"),
    );
    expect(calls).toContain("parse_odydata");
  });

  it("routes a magres file through the magres parser", async () => {
    await sync.parseStructureFile(
      fakeFile(
        "si_nmr.magres",
        "#$magres-abinitio-v1.0\n[atoms]\n atom Si Si 1 0.0 0.0 0.0\n[/atoms]\n",
      ),
    );
    expect(calls).toContain("parse_magres");
  });
  it("routes a GAMESS file through the GAMESS parser", async () => {
    await sync.parseStructureFile(
      fakeFile(
        "run.gamess",
        " COORDINATES OF ALL ATOMS ARE (ANGS)\n   ATOM   CHARGE       X              Y              Z\n ------------------------------------------------------------\n O           8.0    0.0    0.0    0.0\n",
      ),
    );
    expect(calls).toContain("parse_gamess");
  });
  it("routes a CASTEP phonon file through the CASTEP phonon parser", async () => {
    await sync.parseStructureFile(
      fakeFile(
        "si_gamma.phonon",
        " BEGIN header\n Number of ions 1\n Unit cell vectors (A)\n 5.0 0.0 0.0\n 0.0 5.0 0.0\n 0.0 0.0 5.0\n Fractional Co-ordinates\n  1 0.0 0.0 0.0 Si 28.0\n END header\n",
      ),
    );
    expect(calls).toContain("parse_phonon");
  });

  it("parseStructureText defaults to PDB and honors fileName", async () => {
    await sync.parseStructureText("ATOM", "y.cif");
    expect(calls).toContain("parse_cif");
    await sync.parseStructureText("ATOM");
    expect(calls).toContain("parse_pdb");
  });

  it("parses each trajectory format", async () => {
    await sync.parseXTCFile(fakeFile("t.xtc"), 4);
    await sync.parseDCDFile(fakeFile("t.dcd"), 4);
    await sync.parseNetCDFFile(fakeFile("t.nc"), 4);
    await sync.parseLammpstrjFile(fakeFile("t.lammpstrj"), 4);
    expect(calls).toEqual(
      expect.arrayContaining([
        "parse_xtc_file",
        "parse_dcd_file",
        "parse_netcdf_file",
        "parse_lammpstrj_file",
      ]),
    );
  });

  it("throws on a trajectory atom-count mismatch", async () => {
    await expect(sync.parseXTCFile(fakeFile("t.xtc"), 99)).rejects.toThrow(/atom count/);
  });

  it("exposes bond and label helpers", async () => {
    const core = await import("@/parsers/parseCore");
    expect(await core.inferBondsVdw(new Float32Array(6), new Uint8Array(2), 2)).toBeInstanceOf(
      Uint32Array,
    );
    expect(await core.parseTopBonds("x", 2)).toBeInstanceOf(Uint32Array);
    expect(await core.parseTopBondsWithIncludes("x", {}, 2)).toBeInstanceOf(Uint32Array);
    expect(await core.parsePsfBonds("x", 2)).toBeInstanceOf(Uint32Array);
    expect(await core.parsePdbBonds("x", 2)).toBeInstanceOf(Uint32Array);
    const labels = await core.extractLabelsFromFile(fakeFile("x.gro"), 2);
    expect(labels).toHaveLength(2); // trimmed to nAtoms
    const txt = await core.extractLabelsFromFile(fakeFile("notes.txt", "a\nb"), 3);
    expect(txt).toEqual(["a", "b", ""]); // padded to nAtoms
  });

  it("degrades the lazy XTC exports to eager (worker-only feature)", async () => {
    // On the sync path (JupyterLab/anywidget / worker-unavailable), indexXTCFile
    // returns null so the caller falls back to eager parseXTCFile; decode is
    // never reached and dispose is a no-op.
    expect(await sync.indexTrajectoryLazy(fakeFile("t.xtc"), "xtc", 4)).toBeNull();
    // frame-0 partial decode also needs a worker → null (caller does a full read).
    expect(await sync.decodeTrajectoryFrame0(fakeFile("t.xtc"), "xtc", 4)).toBeNull();
    await expect(sync.decodeTrajectoryFrame(0, 0)).rejects.toThrow(/worker-only/);
    expect(() => sync.disposeTrajectoryLazy(0)).not.toThrow();
    // Never streams on the sync path, regardless of file size.
    expect(sync.shouldUseLazyTrajectory("xtc", 1)).toBe(false);
    expect(sync.shouldUseLazyTrajectory("lammpstrj", 1024 * 1024 * 1024)).toBe(false);
  });

  it("degrades the lazy structure exports to eager (worker-only feature)", async () => {
    // Multi-frame XYZ/PDB streaming needs a worker; the sync path never uses it.
    expect(await sync.indexStructureLazy(fakeFile("m.xyz"), "xyz")).toBeNull();
    expect(await sync.parseStructurePrefix(fakeFile("m.xyz"), "xyz")).toBeNull();
    expect(sync.shouldUseLazyStructure("xyz", 1024 * 1024 * 1024)).toBe(false);
  });

  it("indexStructureCore surfaces the decoder's heterogeneous flag", async () => {
    const core = await import("@/parsers/parseCore");
    await core.ensureInit();
    const { decoder, index } = core.indexStructureCore(new Uint8Array([1]), "xyz");
    // The mock decoder reports heterogeneous=true → the host will reparse eagerly.
    expect(index.heterogeneous).toBe(true);
    expect(index.nFrames).toBe(2);
    decoder.free();
  });
});
