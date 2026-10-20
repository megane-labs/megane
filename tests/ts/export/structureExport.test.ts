import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeStructure, downloadBlob } = vi.hoisted(() => ({
  writeStructure: vi.fn(async () => "3\ngenerated\n"),
  downloadBlob: vi.fn(),
}));

vi.mock("@/parsers/parseCore", () => ({ writeStructure }));
vi.mock("@/renderer/RenderCapture", () => ({ downloadBlob }));

import {
  defaultExportFormat,
  exportBaseName,
  exportFileName,
  formatNeedsCell,
  hasExportCell,
  snapshotToText,
  exportSnapshot,
  STRUCTURE_EXPORT_FORMATS,
} from "@/export/structureExport";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array(9),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: new Uint8Array([1, 1]),
    box: new Float32Array(9),
    boxOrigin: null,
    atomChainIds: new Uint8Array([65, 65, 65]),
    atomBFactors: null,
  };
}

describe("structureExport", () => {
  beforeEach(() => {
    writeStructure.mockClear();
    downloadBlob.mockClear();
  });

  it("strips known structure extensions from the base name", () => {
    expect(exportBaseName("water.pdb")).toBe("water");
    expect(exportBaseName("/tmp/dir/protein.mmcif")).toBe("protein");
    expect(exportBaseName("notes.txt")).toBe("notes.txt");
    expect(exportBaseName(null)).toBe("structure");
    expect(exportBaseName("")).toBe("structure");
  });

  it("offers xyz / pdb / mol / cif / poscar, the last two only with a cell", () => {
    expect(STRUCTURE_EXPORT_FORMATS.map((f) => f.value)).toEqual([
      "xyz",
      "pdb",
      "mol",
      "cif",
      "poscar",
    ]);
    expect(STRUCTURE_EXPORT_FORMATS.filter((f) => f.needsCell).map((f) => f.value)).toEqual([
      "cif",
      "poscar",
    ]);
    expect(STRUCTURE_EXPORT_FORMATS.find((f) => f.value === "poscar")).toMatchObject({
      label: "POSCAR",
      ext: ".vasp",
    });
    expect(formatNeedsCell("cif")).toBe(true);
    expect(formatNeedsCell("poscar")).toBe(true);
    expect(formatNeedsCell("xyz")).toBe(false);
    expect(formatNeedsCell("pdb")).toBe(false);
    expect(formatNeedsCell("mol")).toBe(false);
  });

  it("tells a usable cell from a missing, empty or flat one", () => {
    expect(hasExportCell(new Float32Array([5, 0, 0, 0, 5, 0, 0, 0, 5]))).toBe(true);
    expect(hasExportCell([4, 0, 0, 1, 4, 0, 0.5, 0.5, 6])).toBe(true);
    expect(hasExportCell(null)).toBe(false);
    expect(hasExportCell(undefined)).toBe(false);
    expect(hasExportCell(new Float32Array(9))).toBe(false);
    expect(hasExportCell(new Float32Array(3))).toBe(false);
    // Coplanar vectors (c in the ab plane).
    expect(hasExportCell([1, 0, 0, 0, 1, 0, 1, 1, 0])).toBe(false);
    // A zero-length vector.
    expect(hasExportCell([1, 0, 0, 0, 0, 0, 0, 0, 1])).toBe(false);
    expect(hasExportCell([NaN, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(false);
  });

  it("strips VASP extensions and keeps bare VASP names", () => {
    expect(exportBaseName("si.vasp")).toBe("si");
    expect(exportBaseName("si.POSCAR")).toBe("si");
    expect(exportBaseName("quartz.cif")).toBe("quartz");
    expect(exportBaseName("1abc.ent")).toBe("1abc");
    expect(exportBaseName("POSCAR")).toBe("POSCAR");
    expect(exportBaseName("run/CONTCAR")).toBe("CONTCAR");
    expect(exportBaseName(".pdb")).toBe("structure");
  });

  it("names exported files by format, keeping VASP names for POSCAR", () => {
    expect(exportFileName("quartz.cif", "poscar")).toBe("quartz.vasp");
    expect(exportFileName("si.vasp", "cif")).toBe("si.cif");
    expect(exportFileName("POSCAR", "poscar")).toBe("POSCAR");
    expect(exportFileName("CONTCAR_relaxed", "poscar")).toBe("CONTCAR_relaxed");
    expect(exportFileName("POSCAR", "xyz")).toBe("POSCAR.xyz");
    expect(exportFileName("XDATCAR", "poscar")).toBe("XDATCAR.vasp");
    expect(exportFileName(null, "cif")).toBe("structure.cif");
  });

  it("defaults Save to the document's own writable format", () => {
    expect(defaultExportFormat("a.pdb")).toBe("pdb");
    expect(defaultExportFormat("a.ent")).toBe("pdb");
    expect(defaultExportFormat("a.mmcif")).toBe("pdb");
    expect(defaultExportFormat("a.sdf")).toBe("mol");
    expect(defaultExportFormat("a.MOL")).toBe("mol");
    expect(defaultExportFormat("quartz.cif")).toBe("cif");
    expect(defaultExportFormat("si.vasp")).toBe("poscar");
    expect(defaultExportFormat("si.poscar")).toBe("poscar");
    expect(defaultExportFormat("POSCAR")).toBe("poscar");
    expect(defaultExportFormat("/runs/CONTCAR_relaxed")).toBe("poscar");
    expect(defaultExportFormat("XDATCAR")).toBe("poscar");
    expect(defaultExportFormat("a.gro")).toBe("xyz");
    expect(defaultExportFormat("untitled")).toBe("xyz");
    expect(defaultExportFormat(null)).toBe("xyz");
    // Without a cell, a cell-only format falls back to XYZ.
    expect(defaultExportFormat("quartz.cif", false)).toBe("xyz");
    expect(defaultExportFormat("POSCAR", false)).toBe("xyz");
    expect(defaultExportFormat("a.pdb", false)).toBe("pdb");
  });

  it("passes the snapshot channels to the writer, dropping mismatched labels", async () => {
    const s = water();
    await snapshotToText(s, "pdb", ["HOH1", "HOH1", "HOH1"]);
    expect(writeStructure).toHaveBeenCalledWith("pdb", s.positions, s.elements, s.bonds, {
      bondOrders: s.bondOrders,
      box: s.box,
      boxOrigin: null,
      atomLabels: ["HOH1", "HOH1", "HOH1"],
      chainIds: s.atomChainIds,
    });
    await snapshotToText(s, "xyz", ["only-one"]);
    expect(writeStructure).toHaveBeenLastCalledWith(
      "xyz",
      s.positions,
      s.elements,
      s.bonds,
      expect.objectContaining({ atomLabels: null }),
    );
  });

  it("passes the cell origin through for the cell-based writers", async () => {
    const s = { ...water(), boxOrigin: new Float32Array([1, 2, 3]) };
    await snapshotToText(s, "cif");
    expect(writeStructure).toHaveBeenLastCalledWith(
      "cif",
      s.positions,
      s.elements,
      s.bonds,
      expect.objectContaining({ box: s.box, boxOrigin: s.boxOrigin }),
    );
  });

  it("downloads the written text under the source name with the new extension", async () => {
    const name = await exportSnapshot(water(), "xyz", "water.pdb");
    expect(name).toBe("water.xyz");
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, fileName] = downloadBlob.mock.calls[0] as [Blob, string];
    expect(fileName).toBe("water.xyz");
    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe("3\ngenerated\n".length);
  });
});
