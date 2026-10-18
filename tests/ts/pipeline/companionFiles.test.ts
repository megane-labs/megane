import { describe, it, expect } from "vitest";
import {
  COMPANION_FILE_PARAMS,
  COMPANION_NODE_TYPES,
  EMBEDDED_VECTOR_PREFIX,
  companionFileName,
  companionFilesFromPayload,
  isCompanionNodeType,
} from "@/pipeline/companionFiles";
import { NODE_PORTS, defaultParams, type PipelineNodeType } from "@/pipeline/types";

describe("COMPANION_FILE_PARAMS", () => {
  it("lists every file-bearing node type", () => {
    expect([...COMPANION_NODE_TYPES].sort()).toEqual(
      [
        "add_bond",
        "load_spectrum",
        "load_structure",
        "load_trajectory",
        "load_vector",
        "load_volumetric",
      ].sort(),
    );
  });

  it("names only real node types", () => {
    for (const type of COMPANION_NODE_TYPES) expect(NODE_PORTS).toHaveProperty(type);
  });

  it("covers every node type whose default params carry a fileName", () => {
    // A new Load* node gets a `fileName` param; this keeps it from being
    // forgotten here (and so silently dropped by the pipeline hosts).
    const withFileName = (Object.keys(NODE_PORTS) as PipelineNodeType[]).filter(
      (t) => "fileName" in defaultParams(t),
    );
    for (const type of withFileName) {
      expect(COMPANION_FILE_PARAMS).toHaveProperty(type, "fileName");
    }
  });
});

describe("isCompanionNodeType", () => {
  it.each([
    ["load_structure", true],
    ["add_bond", true],
    ["viewport", false],
    ["constructor", false],
    [undefined, false],
    [42, false],
  ])("%s → %s", (type, expected) => {
    expect(isCompanionNodeType(type)).toBe(expected);
  });
});

describe("companionFileName", () => {
  it("reads fileName for the Load nodes", () => {
    expect(companionFileName({ type: "load_structure", fileName: "a/b.traj" })).toBe("a/b.traj");
    expect(companionFileName({ type: "load_spectrum", fileName: "ir.jdx" })).toBe("ir.jdx");
  });

  it("reads bondFileName for add_bond, ignoring a stray fileName", () => {
    expect(companionFileName({ type: "add_bond", bondFileName: "topol.top" })).toBe("topol.top");
    expect(companionFileName({ type: "add_bond", fileName: "topol.top" })).toBeNull();
  });

  it("returns null for missing, empty, or non-string names", () => {
    expect(companionFileName({ type: "load_structure", fileName: null })).toBeNull();
    expect(companionFileName({ type: "load_structure", fileName: "" })).toBeNull();
    expect(companionFileName({ type: "load_structure", fileName: 3 })).toBeNull();
    expect(companionFileName({ type: "load_structure" })).toBeNull();
  });

  it("returns null for node types that read no file", () => {
    expect(companionFileName({ type: "filter", fileName: "x.pdb" })).toBeNull();
    expect(companionFileName({ fileName: "x.pdb" })).toBeNull();
  });

  it("skips a load_vector fed by an embedded channel", () => {
    expect(
      companionFileName({ type: "load_vector", fileName: `${EMBEDDED_VECTOR_PREFIX}velocities` }),
    ).toBeNull();
    expect(companionFileName({ type: "load_vector", fileName: "forces.vec" })).toBe("forces.vec");
  });
});

describe("companionFilesFromPayload", () => {
  it("rebuilds Files from raw bytes without altering them", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const [file] = companionFilesFromPayload([
      { nodeId: "s", nodeType: "load_structure", filename: "water.traj", content: bytes.buffer },
    ]);
    expect(file.name).toBe("water.traj");
    expect(file.size).toBe(4);
    const roundTrip = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(file);
    });
    expect(new Uint8Array(roundTrip)).toEqual(bytes);
  });

  it("keeps the payload order", () => {
    const files = companionFilesFromPayload([
      { nodeId: "a", nodeType: "load_structure", filename: "a.pdb", content: new ArrayBuffer(1) },
      { nodeId: "b", nodeType: "add_bond", filename: "b.top", content: new ArrayBuffer(2) },
    ]);
    expect(files.map((f) => f.name)).toEqual(["a.pdb", "b.top"]);
  });
});
