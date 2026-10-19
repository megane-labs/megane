import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { mergeGeneratedGraph, FILE_BOUND_PARAM_KEYS } from "@/pipeline/generatedApply";
import type { NodeSnapshotData, PipelineNodeData } from "@/pipeline/execute";
import type { NodeStreamingData } from "@/pipeline/executors/streaming";

function node(
  id: string,
  type: string,
  params: Record<string, unknown> = {},
  extra: Partial<Node<PipelineNodeData>> = {},
): Node<PipelineNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { params: { type, ...params } as never, enabled: true },
    ...extra,
  };
}

const snap = { snapshot: { nAtoms: 3 }, frames: null, meta: null, labels: null } as never;
const stream = { connected: true } as unknown as NodeStreamingData;

function prevGraph(nodes: Node<PipelineNodeData>[], snapshots: Record<string, NodeSnapshotData>) {
  return { nodes, nodeSnapshots: snapshots, nodeParseErrors: {}, nodeStreamingData: {} };
}

describe("mergeGeneratedGraph", () => {
  it("keeps a kept loader's file params and data, letting the model change the rest", () => {
    const prev = {
      nodes: [
        node("loader-1", "load_structure", {
          fileName: "mol.pdb",
          hasTrajectory: true,
          hasCell: true,
          edits: [{ kind: "delete_atoms" }],
        }),
        node("vol-1", "load_volumetric", { fileName: "rho.cube", volumetricData: { grid: 1 } }),
        node("stream-1", "streaming", { connected: true }),
      ],
      nodeSnapshots: { "loader-1": snap },
      nodeParseErrors: { "vol-1": "bad header" },
      nodeStreamingData: { "stream-1": stream },
    };
    const next = [
      node("loader-1", "load_structure", { fileName: null, hasTrajectory: false }),
      node("vol-1", "load_volumetric", { fileName: null }),
      node("stream-1", "streaming", { connected: false }),
      node("filter-1", "filter", { query: "all" }),
    ];

    const merged = mergeGeneratedGraph(prev, next);

    const loader = merged.nodes[0].data.params as unknown as Record<string, unknown>;
    expect(loader).toMatchObject({
      fileName: "mol.pdb",
      hasTrajectory: true,
      hasCell: true,
      edits: [{ kind: "delete_atoms" }],
    });
    const vol = merged.nodes[1].data.params as unknown as Record<string, unknown>;
    expect(vol.volumetricData).toEqual({ grid: 1 });
    // A param that is not file-bound is the model's to change.
    expect((merged.nodes[2].data.params as unknown as { connected: boolean }).connected).toBe(
      false,
    );
    expect(merged.nodeSnapshots).toEqual({ "loader-1": snap });
    expect(merged.nodeParseErrors).toEqual({ "vol-1": "bad header" });
    expect(merged.nodeStreamingData).toEqual({ "stream-1": stream });
    // Nodes are not mutated.
    expect((next[0].data.params as unknown as { fileName: unknown }).fileName).toBeNull();
  });

  it("drops the data of nodes the model removed or changed the type of", () => {
    const prev = {
      nodes: [node("a", "load_structure", { fileName: "a.pdb" }), node("b", "streaming")],
      nodeSnapshots: { a: snap },
      nodeParseErrors: { a: "oops" },
      nodeStreamingData: { b: stream },
    };
    const merged = mergeGeneratedGraph(prev, [node("b", "filter")]);
    expect(merged.nodeSnapshots).toEqual({});
    expect(merged.nodeParseErrors).toEqual({});
    expect(merged.nodeStreamingData).toEqual({});
    expect((merged.nodes[0].data.params as unknown as { fileName?: unknown }).fileName).toBe(
      undefined,
    );
  });

  it("re-attaches the old structure to a from-scratch graph's first unloaded loader", () => {
    const prev = prevGraph(
      [node("old-loader", "load_structure", { fileName: "mol.pdb", hasCell: true })],
      { "old-loader": snap },
    );
    const merged = mergeGeneratedGraph(prev, [
      node("v", "viewport"),
      node("new-loader", "load_structure", { fileName: null, hasCell: false }),
      node("second-loader", "load_structure", { fileName: null }),
    ]);

    expect(merged.nodeSnapshots).toEqual({ "new-loader": snap });
    expect(merged.nodes[1].data.params).toMatchObject({ fileName: "mol.pdb", hasCell: true });
    expect((merged.nodes[2].data.params as unknown as { fileName: unknown }).fileName).toBeNull();
  });

  it("does not re-attach when the old loader had nothing loaded or the graph has no loader", () => {
    const unloaded = prevGraph([node("old", "load_structure", { fileName: "x.pdb" })], {});
    expect(
      mergeGeneratedGraph(unloaded, [node("new", "load_structure", { fileName: null })])
        .nodeSnapshots,
    ).toEqual({});

    const loaded = prevGraph([node("old", "load_structure")], { old: snap });
    expect(mergeGeneratedGraph(loaded, [node("v", "viewport")]).nodeSnapshots).toEqual({});
  });

  it("keeps the selection of nodes the model kept", () => {
    const prev = prevGraph([node("f", "filter", {}, { selected: true }), node("c", "color")], {});
    const merged = mergeGeneratedGraph(prev, [node("f", "filter"), node("c", "color")]);
    expect(merged.nodes[0].selected).toBe(true);
    expect(merged.nodes[1].selected).toBeUndefined();
  });

  it("lists every ephemeral loader field the serializer strips", () => {
    for (const key of ["bondFileData", "volumetricData", "spectrumData", "parseError"]) {
      expect(FILE_BOUND_PARAM_KEYS).toContain(key);
    }
  });
});
