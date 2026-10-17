import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { ReplicateNode } from "@/components/nodes/ReplicateNode";
import type { ReplicateParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: ReplicateParams, enabled = true) {
  return {
    id,
    type: "replicate" as const,
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

describe("ReplicateNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the X/Y/Z inputs with values from params", () => {
    const seeded = seedPipelineStore("replicate", {
      id: "r1",
      params: { nx: 2, ny: 3, nz: 4 },
    });
    render(<ReplicateNode {...nodeProps("r1", seeded.data.params as ReplicateParams)} />);

    expect((screen.getByTestId("replicate-node-nx") as HTMLInputElement).value).toBe("2");
    expect((screen.getByTestId("replicate-node-ny") as HTMLInputElement).value).toBe("3");
    expect((screen.getByTestId("replicate-node-nz") as HTMLInputElement).value).toBe("4");
  });

  it("changing X dispatches updateNodeParams with an integer nx", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("replicate", { id: "r1" });
    usePipelineStore.setState({ updateNodeParams });
    render(<ReplicateNode {...nodeProps("r1", seeded.data.params as ReplicateParams)} />);

    fireEvent.change(screen.getByTestId("replicate-node-nx"), { target: { value: "3" } });
    expect(updateNodeParams).toHaveBeenCalledWith("r1", { nx: 3 });
  });

  it("ignores values below 1", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("replicate", { id: "r1" });
    usePipelineStore.setState({ updateNodeParams });
    render(<ReplicateNode {...nodeProps("r1", seeded.data.params as ReplicateParams)} />);

    fireEvent.change(screen.getByTestId("replicate-node-nz"), { target: { value: "0" } });
    expect(updateNodeParams).not.toHaveBeenCalled();
  });

  it("inputs carry the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("replicate", { id: "r1" });
    render(<ReplicateNode {...nodeProps("r1", seeded.data.params as ReplicateParams)} />);
    expect(screen.getByTestId("replicate-node-nx").className).toContain("nodrag");
  });

  it("renders inside a NodeShell with the Replicate title", () => {
    const seeded = seedPipelineStore("replicate", { id: "r1" });
    renderCard(<ReplicateNode {...nodeProps("r1", seeded.data.params as ReplicateParams)} />);
    expect(screen.getByText("Replicate")).toBeInTheDocument();
  });
});
