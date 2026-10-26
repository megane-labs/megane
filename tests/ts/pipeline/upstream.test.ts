import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import { findUpstreamLoadStructureId, getElementsPresentInUpstream } from "@/pipeline/upstream";
import type { PipelineNodeData, NodeSnapshotData } from "@/pipeline/execute";
import type { Snapshot } from "@/types";

function n(id: string, type: string): Node<PipelineNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: { type } as any,
      enabled: true,
    },
  };
}

function e(source: string, target: string, sh = "particle", th = "particle"): Edge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: sh,
    targetHandle: th,
  };
}

function snapshotWithElements(elements: number[]): Snapshot {
  const len = elements.length;
  return {
    nAtoms: len,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(len * 3),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

describe("findUpstreamLoadStructureId", () => {
  it("returns the loader id when directly connected", () => {
    const nodes = [n("loader", "load_structure"), n("poly", "polyhedron_generator")];
    const edges = [e("loader", "poly")];
    expect(findUpstreamLoadStructureId("poly", nodes, edges)).toBe("loader");
  });

  it("traverses transparent nodes (filter, modify) to reach the loader", () => {
    const nodes = [
      n("loader", "load_structure"),
      n("filter1", "filter"),
      n("modify1", "modify"),
      n("poly", "polyhedron_generator"),
    ];
    const edges = [e("loader", "filter1"), e("filter1", "modify1"), e("modify1", "poly")];
    expect(findUpstreamLoadStructureId("poly", nodes, edges)).toBe("loader");
  });

  it("returns null when there is no upstream loader", () => {
    const nodes = [n("poly", "polyhedron_generator")];
    expect(findUpstreamLoadStructureId("poly", nodes, [])).toBeNull();
  });

  it("does not traverse non-transparent nodes (e.g. add_bond's bond branch is OK but unknown types are blocked)", () => {
    // Custom unknown node type breaks the chain.
    const nodes = [
      n("loader", "load_structure"),
      n("custom", "some_unknown_type"),
      n("poly", "polyhedron_generator"),
    ];
    const edges = [e("loader", "custom"), e("custom", "poly")];
    expect(findUpstreamLoadStructureId("poly", nodes, edges)).toBeNull();
  });
});

describe("getElementsPresentInUpstream", () => {
  it("returns the unique atomic numbers from the upstream snapshot", () => {
    const nodes = [n("loader", "load_structure"), n("poly", "polyhedron_generator")];
    const edges = [e("loader", "poly")];
    const snapshots: Record<string, NodeSnapshotData> = {
      loader: {
        snapshot: snapshotWithElements([22, 22, 8, 8, 8, 6]),
        frames: null,
        meta: null,
        labels: null,
      },
    };
    const elements = getElementsPresentInUpstream("poly", nodes, edges, snapshots);
    expect(elements).not.toBeNull();
    expect([...elements!].sort((a, b) => a - b)).toEqual([6, 8, 22]);
  });

  it("reaches the loader through the crystal nodes of the Solid template", () => {
    // loader → symmetry → wrap → replicate → drawing boundary → coordination
    const chain = ["loader", "symmetry", "wrap", "replicate", "boundary", "coord"];
    const types = [
      "load_structure",
      "symmetry",
      "wrap",
      "replicate",
      "drawing_boundary",
      "coordination_generator",
    ];
    const nodes = chain.map((id, i) => n(id, types[i]));
    const edges = chain.slice(1).map((id, i) => e(chain[i], id));
    const snapshots: Record<string, NodeSnapshotData> = {
      loader: {
        snapshot: snapshotWithElements([38, 22, 8, 8, 8]),
        frames: null,
        meta: null,
        labels: null,
      },
    };
    expect(findUpstreamLoadStructureId("coord", nodes, edges)).toBe("loader");
    const elements = getElementsPresentInUpstream("coord", nodes, edges, snapshots);
    expect([...elements!].sort((a, b) => a - b)).toEqual([8, 22, 38]);
  });

  it("returns null when no upstream loader exists", () => {
    const nodes = [n("poly", "polyhedron_generator")];
    expect(getElementsPresentInUpstream("poly", nodes, [], {})).toBeNull();
  });

  it("returns null when loader exists but no snapshot has been recorded yet", () => {
    const nodes = [n("loader", "load_structure"), n("poly", "polyhedron_generator")];
    const edges = [e("loader", "poly")];
    expect(getElementsPresentInUpstream("poly", nodes, edges, {})).toBeNull();
  });
});
