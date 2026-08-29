import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { IsosurfaceNode } from "@/components/nodes/IsosurfaceNode";
import type { IsosurfaceParams } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: IsosurfaceParams, enabled = true) {
  return {
    id,
    type: "isosurface" as const,
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

function seed(params: Record<string, unknown> = {}, id = "iso1") {
  return seedPipelineStore("isosurface", { id, params });
}

describe("IsosurfaceNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders iso level, color mode, solid color picker, and opacity by default", () => {
    const seeded = seed();
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    expect((screen.getByTestId("isosurface-level") as HTMLInputElement).value).toBe("0.05");
    expect((screen.getByTestId("isosurface-color-mode") as HTMLSelectElement).value).toBe("solid");
    expect(screen.getByTestId("isosurface-color")).toBeInTheDocument();
    expect(screen.getByTestId("isosurface-opacity")).toBeInTheDocument();
    // Volume-coloring controls are hidden in solid mode.
    expect(screen.queryByTestId("isosurface-colormap")).toBeNull();
    expect(screen.queryByTestId("isosurface-range-min")).toBeNull();
  });

  it("editing the iso level dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed();
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    fireEvent.change(screen.getByTestId("isosurface-level"), { target: { value: "0.02" } });
    expect(updateNodeParams).toHaveBeenCalledWith("iso1", { isoLevel: 0.02 });
  });

  it("switching color mode to volume dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed();
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    fireEvent.change(screen.getByTestId("isosurface-color-mode"), {
      target: { value: "volume" },
    });
    expect(updateNodeParams).toHaveBeenCalledWith("iso1", { colorMode: "volume" });
  });

  it("volume mode shows colormap + range controls and hides the solid pickers", () => {
    const seeded = seed({ colorMode: "volume" });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    expect((screen.getByTestId("isosurface-colormap") as HTMLSelectElement).value).toBe("rwb");
    expect(screen.getByTestId("isosurface-range-min")).toBeInTheDocument();
    expect(screen.getByTestId("isosurface-range-max")).toBeInTheDocument();
    expect(screen.queryByTestId("isosurface-color")).toBeNull();
  });

  it("changing the colormap dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed({ colorMode: "volume" });
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    fireEvent.change(screen.getByTestId("isosurface-colormap"), {
      target: { value: "rainbow" },
    });
    expect(updateNodeParams).toHaveBeenCalledWith("iso1", { colormap: "rainbow" });
  });

  it("a complete min/max pair commits colorRange", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed({ colorMode: "volume" });
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    fireEvent.change(screen.getByTestId("isosurface-range-min"), { target: { value: "-0.1" } });
    // Half-typed pair clears the override back to auto.
    expect(updateNodeParams).toHaveBeenLastCalledWith("iso1", { colorRange: undefined });
    fireEvent.change(screen.getByTestId("isosurface-range-max"), { target: { value: "0.2" } });
    expect(updateNodeParams).toHaveBeenLastCalledWith("iso1", { colorRange: [-0.1, 0.2] });
  });

  it("an inverted range clears colorRange back to auto", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed({ colorMode: "volume", colorRange: [-1, 1] });
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    // Existing range pre-fills the inputs.
    expect((screen.getByTestId("isosurface-range-min") as HTMLInputElement).value).toBe("-1");
    expect((screen.getByTestId("isosurface-range-max") as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByTestId("isosurface-range-max"), { target: { value: "-5" } });
    expect(updateNodeParams).toHaveBeenLastCalledWith("iso1", { colorRange: undefined });
  });

  it("shows the negative color picker only with showNegative in solid mode", () => {
    const solidSeed = seed({ showNegative: true });
    render(<IsosurfaceNode {...nodeProps("iso1", solidSeed.data.params as IsosurfaceParams)} />);
    expect(screen.getByTestId("isosurface-negative-color")).toBeInTheDocument();
    cleanup();

    const volumeSeed = seed({ showNegative: true, colorMode: "volume" }, "iso2");
    render(<IsosurfaceNode {...nodeProps("iso2", volumeSeed.data.params as IsosurfaceParams)} />);
    expect(screen.queryByTestId("isosurface-negative-color")).toBeNull();
  });

  it("toggling showNegative dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed();
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    fireEvent.click(screen.getByTestId("isosurface-show-negative"));
    expect(updateNodeParams).toHaveBeenCalledWith("iso1", { showNegative: true });
  });

  it("changing opacity dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seed();
    usePipelineStore.setState({ updateNodeParams });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    fireEvent.change(screen.getByTestId("isosurface-opacity"), { target: { value: "0.3" } });
    expect(updateNodeParams).toHaveBeenCalledWith("iso1", { opacity: 0.3 });
  });

  it("controls carry the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seed({ colorMode: "volume" });
    render(<IsosurfaceNode {...nodeProps("iso1", seeded.data.params as IsosurfaceParams)} />);
    expect(screen.getByTestId("isosurface-color-mode").className).toContain("nodrag");
    expect(screen.getByTestId("isosurface-colormap").className).toContain("nodrag");
    expect(screen.getByTestId("isosurface-range-min").className).toContain("nodrag");
  });
});
