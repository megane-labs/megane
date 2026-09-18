import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { EditNode, summarizeEditOps } from "@/components/nodes/EditNode";
import type { EditParams, EditOp } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: EditParams, enabled = true) {
  return {
    id,
    type: "edit" as const,
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

const OPS: EditOp[] = [
  { op: "add_atom", id: "a", element: 6, position: [0, 0, 0] },
  { op: "add_atom", id: "b", element: 6, position: [1, 0, 0] },
  { op: "delete_atoms", atoms: [0] },
];

describe("EditNode", () => {
  beforeEach(() => {
    cleanup();
    usePipelineUIStore.setState({ mode: "editor" });
  });

  it("summarizes the op list", () => {
    expect(summarizeEditOps([])).toBe("No edits");
    expect(summarizeEditOps(OPS)).toBe("2 add atom · 1 delete");
    expect(summarizeEditOps([{ op: "set_cell", box: null }])).toBe("1 cell");
  });

  it("renders the summary and op count from params", () => {
    const seeded = seedPipelineStore("edit", { id: "e1", params: { ops: OPS } });
    render(<EditNode {...nodeProps("e1", seeded.data.params as EditParams)} />);
    expect(screen.getByTestId("edit-node-summary").textContent).toBe("2 add atom · 1 delete");
    expect(screen.getByTestId("edit-node-count").textContent).toBe("3 ops");
  });

  it("Undo last drops the trailing op; Clear drops them all", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("edit", { id: "e1", params: { ops: OPS } });
    usePipelineStore.setState({ updateNodeParams });
    render(<EditNode {...nodeProps("e1", seeded.data.params as EditParams)} />);

    fireEvent.click(screen.getByTestId("edit-node-undo"));
    expect(updateNodeParams).toHaveBeenCalledWith("e1", { ops: OPS.slice(0, 2) });
    fireEvent.click(screen.getByTestId("edit-node-clear"));
    expect(updateNodeParams).toHaveBeenCalledWith("e1", { ops: [] });
  });

  it("disables Undo / Clear with no ops and tolerates a malformed ops field", () => {
    const seeded = seedPipelineStore("edit", { id: "e1", params: { ops: null } });
    render(<EditNode {...nodeProps("e1", seeded.data.params as EditParams)} />);
    expect((screen.getByTestId("edit-node-undo") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("edit-node-clear") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("edit-node-summary").textContent).toBe("No edits");
  });

  it("Open Build switches the pipeline panel to the Build tab", () => {
    const seeded = seedPipelineStore("edit", { id: "e1" });
    render(<EditNode {...nodeProps("e1", seeded.data.params as EditParams)} />);
    fireEvent.click(screen.getByTestId("edit-node-open-build"));
    expect(usePipelineUIStore.getState().mode).toBe("build");
  });
});
