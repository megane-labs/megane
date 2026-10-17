import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { ViewportNode } from "@/components/nodes/ViewportNode";
import type { ViewportParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: ViewportParams, enabled = true) {
  return {
    id,
    type: "viewport" as const,
    data: { params, enabled },
    selected: false,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
    // xyflow's NodeProps has many optional fields; these are the ones our
    // node component actually reads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("ViewportNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the three display toggles with checked state from params", () => {
    const seeded = seedPipelineStore("viewport", {
      id: "v1",
      params: { perspective: true, cellAxesVisible: false, pivotMarkerVisible: true },
    });
    render(<ViewportNode {...nodeProps("v1", seeded.data.params as ViewportParams)} />);

    const perspective = screen.getByLabelText("Perspective") as HTMLInputElement;
    const cellAxes = screen.getByLabelText("Cell axes") as HTMLInputElement;
    const pivotMarker = screen.getByLabelText("Pivot marker") as HTMLInputElement;

    expect(perspective.checked).toBe(true);
    expect(cellAxes.checked).toBe(false);
    expect(pivotMarker.checked).toBe(true);
  });

  it("toggling Perspective calls updateNodeParams with the new value", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("viewport", { id: "v1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<ViewportNode {...nodeProps("v1", seeded.data.params as ViewportParams)} />);
    fireEvent.click(screen.getByLabelText("Perspective"));

    expect(updateNodeParams).toHaveBeenCalledWith("v1", { perspective: true });
  });

  it("toggling Cell axes calls updateNodeParams with the new value", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("viewport", {
      id: "v1",
      params: { cellAxesVisible: true },
    });
    usePipelineStore.setState({ updateNodeParams });

    render(<ViewportNode {...nodeProps("v1", seeded.data.params as ViewportParams)} />);
    fireEvent.click(screen.getByLabelText("Cell axes"));

    expect(updateNodeParams).toHaveBeenCalledWith("v1", { cellAxesVisible: false });
  });

  it("toggling Pivot marker calls updateNodeParams with the new value", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("viewport", {
      id: "v1",
      params: { pivotMarkerVisible: true },
    });
    usePipelineStore.setState({ updateNodeParams });

    render(<ViewportNode {...nodeProps("v1", seeded.data.params as ViewportParams)} />);
    fireEvent.click(screen.getByLabelText("Pivot marker"));

    expect(updateNodeParams).toHaveBeenCalledWith("v1", { pivotMarkerVisible: false });
  });

  it("renders inside a NodeShell with the Viewport title and no delete button", () => {
    const seeded = seedPipelineStore("viewport", { id: "v1" });
    renderCard(<ViewportNode {...nodeProps("v1", seeded.data.params as ViewportParams)} />);

    expect(screen.getByText("Viewport")).toBeInTheDocument();
    expect(screen.queryByTitle("Remove node")).toBeNull();
  });

  it("does not render a Representation control (moved to its own node)", () => {
    const seeded = seedPipelineStore("viewport", { id: "v1" });
    render(<ViewportNode {...nodeProps("v1", seeded.data.params as ViewportParams)} />);
    expect(screen.queryByTestId("viewport-representation-select")).toBeNull();
  });
});
