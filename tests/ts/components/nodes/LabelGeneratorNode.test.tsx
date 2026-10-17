import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { LabelGeneratorNode } from "@/components/nodes/LabelGeneratorNode";
import type { LabelGeneratorParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: LabelGeneratorParams, enabled = true) {
  return {
    id,
    type: "label_generator" as const,
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

describe("LabelGeneratorNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the three source tabs: Element, Resname, Index", () => {
    const seeded = seedPipelineStore("label_generator", { id: "lg1" });
    render(
      <LabelGeneratorNode {...nodeProps("lg1", seeded.data.params as LabelGeneratorParams)} />,
    );

    expect(screen.getByRole("tab", { name: "Element" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Resname" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Index" })).toBeInTheDocument();
  });

  it("renders inside a NodeShell with the Labels title", () => {
    const seeded = seedPipelineStore("label_generator", { id: "lg1" });
    renderCard(
      <LabelGeneratorNode {...nodeProps("lg1", seeded.data.params as LabelGeneratorParams)} />,
    );
    expect(screen.getByText("Labels")).toBeInTheDocument();
  });

  it("clicking a non-active tab dispatches updateNodeParams with the new source", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("label_generator", {
      id: "lg1",
      params: { source: "element" },
    });
    usePipelineStore.setState({ updateNodeParams });
    render(
      <LabelGeneratorNode {...nodeProps("lg1", seeded.data.params as LabelGeneratorParams)} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Resname" }));
    expect(updateNodeParams).toHaveBeenCalledWith("lg1", { source: "resname" });

    fireEvent.click(screen.getByRole("tab", { name: "Index" }));
    expect(updateNodeParams).toHaveBeenCalledWith("lg1", { source: "index" });
  });

  it("clicking the already-active tab is a no-op", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("label_generator", {
      id: "lg1",
      params: { source: "element" },
    });
    usePipelineStore.setState({ updateNodeParams });
    render(
      <LabelGeneratorNode {...nodeProps("lg1", seeded.data.params as LabelGeneratorParams)} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Element" }));
    expect(updateNodeParams).not.toHaveBeenCalled();
  });

  it("uses the active-tab color for the currently-selected source", () => {
    const seeded = seedPipelineStore("label_generator", {
      id: "lg1",
      params: { source: "resname" },
    });
    render(
      <LabelGeneratorNode {...nodeProps("lg1", seeded.data.params as LabelGeneratorParams)} />,
    );

    const active = screen.getByRole("tab", { name: "Resname" });
    const inactive = screen.getByRole("tab", { name: "Element" });
    // Active tab uses the primary CSS variable; inactive uses the muted variable
    expect(active.style.color).toBe("var(--megane-primary)");
    expect(inactive.style.color).toBe("var(--megane-text-muted)");
  });
});
