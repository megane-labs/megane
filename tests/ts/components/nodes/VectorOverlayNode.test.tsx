import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { VectorOverlayNode } from "@/components/nodes/VectorOverlayNode";
import type { VectorOverlayParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: VectorOverlayParams, enabled = true) {
  return {
    id,
    type: "vector_overlay" as const,
    data: { params, enabled },
    selected: false,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("VectorOverlayNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the Vectors title and the Scale label", () => {
    const seeded = seedPipelineStore("vector_overlay", { id: "vo1" });
    const props = nodeProps("vo1", seeded.data.params as VectorOverlayParams);
    const card = renderCard(<VectorOverlayNode {...props} />);
    expect(screen.getByText("Vectors")).toBeInTheDocument();
    card.unmount();
    render(<VectorOverlayNode {...props} />);
    expect(screen.getByText("Scale")).toBeInTheDocument();
  });

  it("renders the slider with the value from params and a 1-decimal label", () => {
    const seeded = seedPipelineStore("vector_overlay", {
      id: "vo1",
      params: { scale: 2.5 },
    });
    render(<VectorOverlayNode {...nodeProps("vo1", seeded.data.params as VectorOverlayParams)} />);

    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe("2.5");
    expect(screen.getByText("2.5")).toBeInTheDocument();
  });

  it("changing the slider dispatches updateNodeParams with the parsed float", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("vector_overlay", { id: "vo1" });
    usePipelineStore.setState({ updateNodeParams });
    render(<VectorOverlayNode {...nodeProps("vo1", seeded.data.params as VectorOverlayParams)} />);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "3.2" } });
    expect(updateNodeParams).toHaveBeenCalledWith("vo1", { scale: 3.2 });
  });

  it("slider has the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("vector_overlay", { id: "vo1" });
    render(<VectorOverlayNode {...nodeProps("vo1", seeded.data.params as VectorOverlayParams)} />);
    expect(screen.getByRole("slider").className).toContain("nodrag");
  });
});
