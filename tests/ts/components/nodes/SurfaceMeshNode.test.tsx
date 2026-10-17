import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { SurfaceMeshNode } from "@/components/nodes/SurfaceMeshNode";
import type { SurfaceMeshParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: SurfaceMeshParams, enabled = true) {
  return {
    id,
    type: "surface_mesh" as const,
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

describe("SurfaceMeshNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the Surface Mesh title", () => {
    const seeded = seedPipelineStore("surface_mesh", { id: "sm1" });
    renderCard(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    expect(screen.getByText("Surface Mesh")).toBeInTheDocument();
  });

  it("renders the alpha radius input with the current value", () => {
    const seeded = seedPipelineStore("surface_mesh", {
      id: "sm1",
      params: { alphaRadius: 4.5 },
    });
    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    const input = screen.getByTestId("surface-mesh-alpha") as HTMLInputElement;
    expect(parseFloat(input.value)).toBeCloseTo(4.5);
  });

  it("renders the color input with the current color", () => {
    const seeded = seedPipelineStore("surface_mesh", {
      id: "sm1",
      params: { color: "#ff8800" },
    });
    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    const input = screen.getByTestId("surface-mesh-color") as HTMLInputElement;
    expect(input.value).toBe("#ff8800");
  });

  it("renders the opacity slider with the current value", () => {
    const seeded = seedPipelineStore("surface_mesh", {
      id: "sm1",
      params: { opacity: 0.7 },
    });
    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    const slider = screen.getByTestId("surface-mesh-opacity") as HTMLInputElement;
    expect(parseFloat(slider.value)).toBeCloseTo(0.7);
  });

  it("displays opacity as a percentage", () => {
    const seeded = seedPipelineStore("surface_mesh", {
      id: "sm1",
      params: { opacity: 0.4 },
    });
    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("changing alpha input calls updateNodeParams with the new value", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("surface_mesh", { id: "sm1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    fireEvent.change(screen.getByTestId("surface-mesh-alpha"), { target: { value: "2.5" } });
    expect(updateNodeParams).toHaveBeenCalledWith("sm1", { alphaRadius: 2.5 });
  });

  it("changing color input calls updateNodeParams with the new color", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("surface_mesh", { id: "sm1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    fireEvent.change(screen.getByTestId("surface-mesh-color"), { target: { value: "#abcdef" } });
    expect(updateNodeParams).toHaveBeenCalledWith("sm1", { color: "#abcdef" });
  });

  it("changing opacity slider calls updateNodeParams with a parsed float", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("surface_mesh", { id: "sm1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    fireEvent.change(screen.getByTestId("surface-mesh-opacity"), { target: { value: "0.8" } });
    expect(updateNodeParams).toHaveBeenCalledWith("sm1", { opacity: 0.8 });
  });

  it("alpha input carries the 'nodrag' class", () => {
    const seeded = seedPipelineStore("surface_mesh", { id: "sm1" });
    render(<SurfaceMeshNode {...nodeProps("sm1", seeded.data.params as SurfaceMeshParams)} />);
    expect(screen.getByTestId("surface-mesh-alpha").className).toContain("nodrag");
  });
});
