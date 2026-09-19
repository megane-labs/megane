import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { findPrimaryLoader, loaderEdits } from "@/pipeline/editHistory";
import type { PipelineNodeData } from "@/pipeline/execute";
import { defaultParams } from "@/pipeline/types";
import type { PipelineNodeType, EditOp, LoadStructureParams } from "@/pipeline/types";

function node(id: string, type: PipelineNodeType, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { params: { ...defaultParams(type), ...extra }, enabled: true },
  } as Node<PipelineNodeData>;
}

describe("editHistory", () => {
  it("finds the first load_structure node, or null", () => {
    const nodes = [
      node("vp-1", "viewport"),
      node("loader-1", "load_structure"),
      node("loader-2", "load_structure"),
    ];
    expect(findPrimaryLoader(nodes)?.id).toBe("loader-1");
    expect(findPrimaryLoader([node("vp-1", "viewport")])).toBeNull();
  });

  it("reads a loader's edit list, treating absent / malformed lists as empty", () => {
    const edits: EditOp[] = [{ op: "delete_atoms", atoms: [0] }];
    expect(loaderEdits(node("l", "load_structure", { edits }))).toBe(edits);
    expect(loaderEdits(node("l", "load_structure"))).toEqual([]);
    expect(loaderEdits(node("l", "load_structure", { edits: "nope" }))).toEqual([]);
    expect(loaderEdits(null)).toEqual([]);
    expect(loaderEdits(undefined)).toEqual([]);
    // The default params carry no list at all: an untouched file serializes without one.
    expect((defaultParams("load_structure") as LoadStructureParams).edits).toBeUndefined();
  });
});
