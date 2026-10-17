import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { ColorNode } from "@/components/nodes/ColorNode";
import type { ColorParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: ColorParams, enabled = true) {
  return {
    id,
    type: "color" as const,
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

describe("ColorNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the mode dropdown with the value from params", () => {
    const seeded = seedPipelineStore("color", {
      id: "c1",
      params: { mode: "byElement" },
    });
    render(<ColorNode {...nodeProps("c1", seeded.data.params as ColorParams)} />);
    const select = screen.getByTestId("color-node-mode") as HTMLSelectElement;
    expect(select.value).toBe("byElement");
  });

  it("renders the uniform color picker only in uniform mode", () => {
    const uniformSeed = seedPipelineStore("color", {
      id: "c1",
      params: { mode: "uniform", uniformColor: "#abcdef" },
    });
    render(<ColorNode {...nodeProps("c1", uniformSeed.data.params as ColorParams)} />);
    const picker = screen.getByTestId("color-node-uniform-color") as HTMLInputElement;
    expect(picker.value).toBe("#abcdef");
    cleanup();

    const elementSeed = seedPipelineStore("color", {
      id: "c2",
      params: { mode: "byElement" },
    });
    render(<ColorNode {...nodeProps("c2", elementSeed.data.params as ColorParams)} />);
    expect(screen.queryByTestId("color-node-uniform-color")).toBeNull();
  });

  it("changing the mode dropdown dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("color", { id: "c1" });
    usePipelineStore.setState({ updateNodeParams });
    render(<ColorNode {...nodeProps("c1", seeded.data.params as ColorParams)} />);
    fireEvent.change(screen.getByTestId("color-node-mode"), {
      target: { value: "byChain" },
    });
    expect(updateNodeParams).toHaveBeenCalledWith("c1", { mode: "byChain" });
  });

  it("changing the uniform color picker dispatches updateNodeParams", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("color", {
      id: "c1",
      params: { mode: "uniform" },
    });
    usePipelineStore.setState({ updateNodeParams });
    render(<ColorNode {...nodeProps("c1", seeded.data.params as ColorParams)} />);
    fireEvent.change(screen.getByTestId("color-node-uniform-color"), {
      target: { value: "#112233" },
    });
    expect(updateNodeParams).toHaveBeenCalledWith("c1", { uniformColor: "#112233" });
  });

  it("renders inside a NodeShell with the Color title", () => {
    const seeded = seedPipelineStore("color", { id: "c1" });
    renderCard(<ColorNode {...nodeProps("c1", seeded.data.params as ColorParams)} />);
    expect(screen.getByText("Color")).toBeInTheDocument();
  });

  it("controls carry the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("color", { id: "c1" });
    render(<ColorNode {...nodeProps("c1", seeded.data.params as ColorParams)} />);
    expect(screen.getByTestId("color-node-mode").className).toContain("nodrag");
  });
});
