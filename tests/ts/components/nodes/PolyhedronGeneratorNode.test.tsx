import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PolyhedronGeneratorNode } from "@/components/nodes/PolyhedronGeneratorNode";
import { usePipelineStore } from "@/pipeline/store";
import { defaultParams, type PolyhedronGeneratorParams } from "@/pipeline/types";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function props(params: Partial<PolyhedronGeneratorParams> = {}) {
  return {
    id: "poly",
    type: "polyhedron_generator",
    data: {
      params: { ...defaultParams("polyhedron_generator"), ...params },
      enabled: true,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("PolyhedronGeneratorNode", () => {
  beforeEach(() => cleanup());

  it("contains mesh appearance controls but no coordination search controls", () => {
    render(<PolyhedronGeneratorNode {...props()} />);
    expect(screen.getByLabelText("Opacity")).toBeInTheDocument();
    expect(screen.queryByLabelText("Neighbor search range")).toBeNull();
    expect(screen.queryByLabelText("Cutoff tolerance")).toBeNull();
  });

  it("updates opacity", () => {
    const updateNodeParams = vi.fn();
    usePipelineStore.setState({ updateNodeParams });
    render(<PolyhedronGeneratorNode {...props({ opacity: 0.4 })} />);
    expect(screen.getByLabelText("Opacity").parentElement).toHaveTextContent("40%");
    fireEvent.change(screen.getByLabelText("Opacity"), { target: { value: "0.75" } });
    expect(updateNodeParams).toHaveBeenCalledWith("poly", { opacity: 0.75 });
  });

  it("shows edge controls only when edges are enabled", () => {
    const { rerender } = render(<PolyhedronGeneratorNode {...props({ showEdges: false })} />);
    expect(screen.queryByText("Edge color")).toBeNull();
    rerender(
      <PolyhedronGeneratorNode
        {...props({ showEdges: true, edgeColor: "#abcdef", edgeWidth: 4 })}
      />,
    );
    expect(screen.getByText("Edge color")).toBeInTheDocument();
    expect(screen.getByText("Edge width")).toBeInTheDocument();
  });

  it("updates edge visibility", () => {
    const updateNodeParams = vi.fn();
    usePipelineStore.setState({ updateNodeParams });
    render(<PolyhedronGeneratorNode {...props()} />);
    fireEvent.click(screen.getByLabelText(/Show edges/));
    expect(updateNodeParams).toHaveBeenCalledWith("poly", { showEdges: true });
  });
});
