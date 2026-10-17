import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { WrapNode } from "@/components/nodes/WrapNode";
import type { WrapParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: WrapParams, enabled = true) {
  return {
    id,
    type: "wrap" as const,
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

describe("WrapNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the dropdown with the value from params", () => {
    const seeded = seedPipelineStore("wrap", { id: "w1", params: { mode: "unwrap" } });
    render(<WrapNode {...nodeProps("w1", seeded.data.params as WrapParams)} />);
    const select = screen.getByTestId("wrap-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("unwrap");
  });

  it("defaults to none when no value is supplied", () => {
    const seeded = seedPipelineStore("wrap", { id: "w1" });
    render(<WrapNode {...nodeProps("w1", seeded.data.params as WrapParams)} />);
    const select = screen.getByTestId("wrap-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("none");
  });

  it("changing the dropdown calls updateNodeParams with the new mode", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("wrap", { id: "w1" });
    usePipelineStore.setState({ updateNodeParams });

    render(<WrapNode {...nodeProps("w1", seeded.data.params as WrapParams)} />);
    fireEvent.change(screen.getByTestId("wrap-node-mode"), { target: { value: "wrap" } });
    expect(updateNodeParams).toHaveBeenCalledWith("w1", { mode: "wrap" });
  });

  it("offers all three modes", () => {
    const seeded = seedPipelineStore("wrap", { id: "w1" });
    render(<WrapNode {...nodeProps("w1", seeded.data.params as WrapParams)} />);
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Wrap" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unwrap" })).toBeInTheDocument();
  });

  it("renders inside a NodeShell with the Wrap / Unwrap title", () => {
    const seeded = seedPipelineStore("wrap", { id: "w1" });
    renderCard(<WrapNode {...nodeProps("w1", seeded.data.params as WrapParams)} />);
    expect(screen.getByText("Wrap / Unwrap")).toBeInTheDocument();
  });

  it("dropdown carries the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("wrap", { id: "w1" });
    render(<WrapNode {...nodeProps("w1", seeded.data.params as WrapParams)} />);
    expect(screen.getByTestId("wrap-node-mode").className).toContain("nodrag");
  });
});
