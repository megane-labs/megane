import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeStructure, downloadBlob } = vi.hoisted(() => ({
  writeStructure: vi.fn(async () => "3\ngenerated\n"),
  downloadBlob: vi.fn(),
}));

vi.mock("@/parsers/parseCore", () => ({ writeStructure }));
vi.mock("@/renderer/RenderCapture", () => ({ downloadBlob }));

import {
  exportBaseName,
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

  it("offers xyz / pdb / mol", () => {
    expect(STRUCTURE_EXPORT_FORMATS.map((f) => f.value)).toEqual(["xyz", "pdb", "mol"]);
  });

  it("passes the snapshot channels to the writer, dropping mismatched labels", async () => {
    const s = water();
    await snapshotToText(s, "pdb", ["HOH1", "HOH1", "HOH1"]);
    expect(writeStructure).toHaveBeenCalledWith("pdb", s.positions, s.elements, s.bonds, {
      bondOrders: s.bondOrders,
      box: s.box,
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
