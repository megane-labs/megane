import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { RepresentationNode } from "@/components/nodes/RepresentationNode";
import type { RepresentationParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: RepresentationParams, enabled = true) {
  return {
    id,
    type: "representation" as const,
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

describe("RepresentationNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the dropdown with the value from params", () => {
    const seeded = seedPipelineStore("representation", {
      id: "r1",
      params: { mode: "cartoon" },
    });
    render(<RepresentationNode {...nodeProps("r1", seeded.data.params as RepresentationParams)} />);
    const select = screen.getByTestId("representation-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("cartoon");
  });

  it("defaults to atoms when no value is supplied", () => {
    const seeded = seedPipelineStore("representation", { id: "r1" });
    render(<RepresentationNode {...nodeProps("r1", seeded.data.params as RepresentationParams)} />);
    const select = screen.getByTestId("representation-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("atoms");
  });

  it("changing the dropdown calls updateNodeParams with the new mode", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("representation", { id: "r1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<RepresentationNode {...nodeProps("r1", seeded.data.params as RepresentationParams)} />);
    fireEvent.change(screen.getByTestId("representation-node-mode"), {
      target: { value: "surface" },
    });
    expect(updateNodeParams).toHaveBeenCalledWith("r1", { mode: "surface" });
  });

  it("offers the Line option and selecting it calls updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("representation", { id: "r1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<RepresentationNode {...nodeProps("r1", seeded.data.params as RepresentationParams)} />);
    expect(screen.getByRole("option", { name: "Line" })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("representation-node-mode"), {
      target: { value: "line" },
    });
    expect(updateNodeParams).toHaveBeenCalledWith("r1", { mode: "line" });
  });

  it("renders inside a NodeShell with the Representation title", () => {
    const seeded = seedPipelineStore("representation", { id: "r1" });
    renderCard(
      <RepresentationNode {...nodeProps("r1", seeded.data.params as RepresentationParams)} />,
    );
    expect(screen.getByText("Representation")).toBeInTheDocument();
  });

  it("dropdown carries the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("representation", { id: "r1" });
    render(<RepresentationNode {...nodeProps("r1", seeded.data.params as RepresentationParams)} />);
    expect(screen.getByTestId("representation-node-mode").className).toContain("nodrag");
  });
});
