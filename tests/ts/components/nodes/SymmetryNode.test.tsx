import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { SymmetryNode } from "@/components/nodes/SymmetryNode";
import type { SymmetryParams } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: SymmetryParams, enabled = true) {
  return {
    id,
    type: "symmetry" as const,
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

describe("SymmetryNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the dropdown with the value from params", () => {
    const seeded = seedPipelineStore("symmetry", { id: "s1", params: { mode: "none" } });
    render(<SymmetryNode {...nodeProps("s1", seeded.data.params as SymmetryParams)} />);
    const select = screen.getByTestId("symmetry-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("none");
  });

  it("defaults to expand when no value is supplied", () => {
    const seeded = seedPipelineStore("symmetry", { id: "s1" });
    render(<SymmetryNode {...nodeProps("s1", seeded.data.params as SymmetryParams)} />);
    const select = screen.getByTestId("symmetry-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("expand");
  });

  it("changing the dropdown calls updateNodeParams with the new mode", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("symmetry", { id: "s1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<SymmetryNode {...nodeProps("s1", seeded.data.params as SymmetryParams)} />);
    fireEvent.change(screen.getByTestId("symmetry-node-mode"), { target: { value: "none" } });
    expect(updateNodeParams).toHaveBeenCalledWith("s1", { mode: "none" });
  });

  it("offers both modes", () => {
    const seeded = seedPipelineStore("symmetry", { id: "s1" });
    render(<SymmetryNode {...nodeProps("s1", seeded.data.params as SymmetryParams)} />);
    expect(screen.getByRole("option", { name: "Expand" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
  });

  it("renders inside a NodeShell with the Symmetry title", () => {
    const seeded = seedPipelineStore("symmetry", { id: "s1" });
    render(<SymmetryNode {...nodeProps("s1", seeded.data.params as SymmetryParams)} />);
    expect(screen.getByText("Symmetry")).toBeInTheDocument();
  });

  it("dropdown carries the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("symmetry", { id: "s1" });
    render(<SymmetryNode {...nodeProps("s1", seeded.data.params as SymmetryParams)} />);
    expect(screen.getByTestId("symmetry-node-mode").className).toContain("nodrag");
  });
});
