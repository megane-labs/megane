// @vitest-environment node
/**
 * The default PDB pipeline (AddBond `bondSource: "structure"`) against real
 * fixtures parsed by the WASM core: a PDB without CONECT records (1UBQ) must
 * still draw its bonds, by distance inference, while a PDB with CONECT
 * records (1CRN) keeps the bonds the structure carries.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { Edge, Node } from "@xyflow/react";
import { ensureInit, parseStructureCore } from "@/parsers/parseCore";
import { executePipeline, type PipelineNodeData } from "@/pipeline/execute";
import { defaultBondSourceForFile } from "@/pipeline/openFile";
import type { Snapshot } from "@/types";

const ROOT = process.cwd();

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
});

function parsePdb(name: string): Snapshot {
  const text = readFileSync(join(ROOT, "tests/fixtures", name), "utf8");
  return parseStructureCore({ ext: ".pdb", text }).snapshot;
}

function bondsDrawn(snapshot: Snapshot, bondSource: string) {
  const node = (id: string, type: string, params: Record<string, unknown>) =>
    ({
      id,
      type,
      position: { x: 0, y: 0 },
      data: { params: { type, ...params }, enabled: true },
    }) as unknown as Node<PipelineNodeData>;
  const nodes = [
    node("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
    node("ab", "add_bond", { bondSource }),
    node("vp", "viewport", {}),
  ];
  const edges: Edge[] = [
    { id: "e1", source: "ls", sourceHandle: "particle", target: "ab", targetHandle: "particle" },
    { id: "e2", source: "ab", sourceHandle: "bond", target: "vp", targetHandle: "bond" },
  ];
  const { viewportState, nodeErrors } = executePipeline(nodes, edges, { snapshot });
  return { nBonds: viewportState.bonds[0]?.nBonds ?? 0, errors: nodeErrors.get("ab") };
}

describe("AddBond 'structure' source on real PDB files", () => {
  it("opens .pdb files with the 'structure' source", () => {
    expect(defaultBondSourceForFile("1ubq.pdb")).toBe("structure");
  });

  it("draws 1ubq.pdb's bonds although the file has no CONECT records", () => {
    const snapshot = parsePdb("1ubq.pdb");
    expect(snapshot.nFileBonds).toBe(0);
    expect(snapshot.nBonds).toBeGreaterThan(0);

    const structure = bondsDrawn(snapshot, "structure");
    expect(structure.errors).toBeUndefined();
    expect(structure.nBonds).toBeGreaterThan(0);
    // The same bonds as the "distance" source, and as many as the parser
    // reports (the Bonds count the HUD shows).
    expect(structure.nBonds).toBe(bondsDrawn(snapshot, "distance").nBonds);
    expect(structure.nBonds).toBe(snapshot.nBonds);
  });

  it("keeps the bonds 1crn.pdb carries (it declares CONECT records)", () => {
    const snapshot = parsePdb("1crn.pdb");
    expect(snapshot.nFileBonds).toBeGreaterThan(0);
    expect(bondsDrawn(snapshot, "structure").nBonds).toBe(snapshot.nBonds);
  });
});
