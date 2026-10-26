import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { CoordinationGeneratorNode } from "@/components/nodes/CoordinationGeneratorNode";
import type { NodeSnapshotData, PipelineNodeData } from "@/pipeline/execute";
import { usePipelineStore } from "@/pipeline/store";
import { defaultParams, type CoordinationGeneratorParams } from "@/pipeline/types";
import type { Snapshot } from "@/types";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function snapshot(elements: number[]): Snapshot {
  return {
    nAtoms: elements.length,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(elements.length * 3),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(),
    bondOrders: null,
    box: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/**
 * Seed load → (via…) → coordination. `via` lists the node types between the
 * loader and Coordination, e.g. the Solid template's symmetry → wrap →
 * drawing_boundary chain.
 */
function seed(params: Partial<CoordinationGeneratorParams> = {}, via: string[] = []) {
  const full = {
    ...defaultParams("coordination_generator"),
    ...params,
  } as CoordinationGeneratorParams;
  const middle: Node<PipelineNodeData>[] = via.map((type, i) => ({
    id: `via-${i}`,
    type,
    position: { x: 0, y: 0 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { params: defaultParams(type as any), enabled: true },
  }));
  const nodes: Node<PipelineNodeData>[] = [
    {
      id: "load",
      type: "load_structure",
      position: { x: 0, y: 0 },
      data: {
        params: { type: "load_structure", fileName: null, hasTrajectory: false, hasCell: true },
        enabled: true,
      },
    },
    ...middle,
    {
      id: "coord",
      type: "coordination_generator",
      position: { x: 0, y: 0 },
      data: { params: full, enabled: true },
    },
  ];
  const chain = nodes.map((node) => node.id);
  const edges: Edge[] = chain.slice(1).map((target, i) => ({
    id: `edge-${i}`,
    source: chain[i],
    target,
    sourceHandle: "particle",
    targetHandle: "particle",
  }));
  const nodeSnapshots: Record<string, NodeSnapshotData> = {
    load: { snapshot: snapshot([22, 8, 1, 18]), frames: null, meta: null, labels: null },
  };
  usePipelineStore.setState({ nodes, edges, nodeSnapshots, nodeErrors: {} });
  return {
    id: "coord",
    type: "coordination_generator",
    data: { params: full, enabled: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("CoordinationGeneratorNode", () => {
  beforeEach(() => cleanup());

  it("selects center and neighbor elements while excluding H and noble gases by default", () => {
    render(<CoordinationGeneratorNode {...seed()} />);
    expect(screen.getByLabelText("Ti")).toBeInTheDocument();
    expect(screen.getByLabelText("O")).toBeInTheDocument();
    expect(screen.queryByLabelText("H")).toBeNull();
    expect(screen.queryByLabelText("Ar")).toBeNull();
  });

  it("updates exclusions, cutoff, and the neighbor search range", () => {
    const updateNodeParams = vi.fn();
    const node = seed();
    usePipelineStore.setState({ updateNodeParams });
    render(<CoordinationGeneratorNode {...node} />);

    fireEvent.click(screen.getByLabelText("Ti"));
    expect(updateNodeParams).toHaveBeenCalledWith("coord", { excludedCenters: [22] });
    fireEvent.change(screen.getByLabelText("Cutoff tolerance"), { target: { value: "1.2" } });
    expect(updateNodeParams).toHaveBeenCalledWith("coord", { cutoffTolerance: 1.2 });
    const mode = screen.getByLabelText("Neighbor search range") as HTMLSelectElement;
    expect(mode.value).toBe("complete");
    fireEvent.change(mode, { target: { value: "inside" } });
    expect(updateNodeParams).toHaveBeenCalledWith("coord", { boundaryMode: "inside" });
  });

  it("lists the elements when the structure arrives through Symmetry, Wrap and Drawing Boundary", () => {
    render(<CoordinationGeneratorNode {...seed({}, ["symmetry", "wrap", "drawing_boundary"])} />);
    expect(screen.getByLabelText("Ti")).toBeInTheDocument();
    expect(screen.getByLabelText("O")).toBeInTheDocument();
    expect(screen.queryByText("None detected")).toBeNull();
  });
});
