import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { ModifyNode } from "@/components/nodes/ModifyNode";
import type { ModifyParams } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: ModifyParams, enabled = true) {
  return {
    id,
    type: "modify" as const,
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

describe("ModifyNode", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the scale and opacity sliders with values from params", () => {
    const seeded = seedPipelineStore("modify", {
      id: "m1",
      params: { scale: 1.25, opacity: 0.4 },
    });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);

    const scale = screen.getByTestId("modify-node-scale") as HTMLInputElement;
    const opacity = screen.getByTestId("modify-node-opacity") as HTMLInputElement;

    expect(scale.value).toBe("1.25");
    expect(opacity.value).toBe("0.4");
  });

  it("formats the scale value to two decimals", () => {
    const seeded = seedPipelineStore("modify", {
      id: "m1",
      params: { scale: 1, opacity: 1 },
    });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);
    expect(screen.getByText("1.00")).toBeInTheDocument();
  });

  it("formats the opacity value as a rounded percentage", () => {
    const seeded = seedPipelineStore("modify", {
      id: "m1",
      params: { scale: 1, opacity: 0.337 },
    });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);
    // 0.337 * 100 = 33.7 → Math.round → 34
    expect(screen.getByText("34%")).toBeInTheDocument();
  });

  it("changing the scale slider dispatches updateNodeParams with parsed float", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("modify", { id: "m1" });
    usePipelineStore.setState({ updateNodeParams });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);

    const scale = screen.getByTestId("modify-node-scale");
    fireEvent.change(scale, { target: { value: "1.5" } });

    expect(updateNodeParams).toHaveBeenCalledWith("m1", { scale: 1.5 });
  });

  it("changing the opacity slider dispatches updateNodeParams with parsed float", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("modify", { id: "m1" });
    usePipelineStore.setState({ updateNodeParams });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);

    const opacity = screen.getByTestId("modify-node-opacity");
    fireEvent.change(opacity, { target: { value: "0.25" } });

    expect(updateNodeParams).toHaveBeenCalledWith("m1", { opacity: 0.25 });
  });

  it("renders inside a NodeShell with the Modify title", () => {
    const seeded = seedPipelineStore("modify", { id: "m1" });
    renderCard(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);
    expect(screen.getByText("Modify")).toBeInTheDocument();
  });

  it("sliders carry the 'nodrag' class so xyflow does not start a node drag", () => {
    const seeded = seedPipelineStore("modify", { id: "m1" });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);
    expect(screen.getByTestId("modify-node-scale").className).toContain("nodrag");
    expect(screen.getByTestId("modify-node-opacity").className).toContain("nodrag");
  });

  it("does not render any color controls (moved to the dedicated Color node)", () => {
    const seeded = seedPipelineStore("modify", { id: "m1" });
    render(<ModifyNode {...nodeProps("m1", seeded.data.params as ModifyParams)} />);
    expect(screen.queryByTestId("modify-node-color-enabled")).toBeNull();
    expect(screen.queryByTestId("modify-node-color-mode")).toBeNull();
    expect(screen.queryByTestId("modify-node-uniform-color")).toBeNull();
  });
});
