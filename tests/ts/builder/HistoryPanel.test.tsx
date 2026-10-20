/**
 * The History panel: Undo / Redo / Undo all, Show original as a real toggle
 * button, rows that jump to their step (applied and undone), and the pause
 * while a preview or the original is shown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { HistoryBody } from "@/builder/HistoryPanel";
import { editSteps, useBuilderStore } from "@/builder/store";
import type { EditOp } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const move = (atom: number): EditOp => ({ op: "move_atoms", atoms: [atom], delta: [1, 0, 0] });
const applied = () => editSteps(useBuilderStore.getState().edits).length;
const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

beforeEach(() => {
  useBuilderStore.getState().closeDocument();
  useBuilderStore.getState().openStructure(water(), null, "w.xyz");
  useBuilderStore.getState().pushOp(move(0), "First");
  useBuilderStore.getState().pushOp(move(1), "Second");
  useBuilderStore.getState().pushOp(move(2), "Third");
});
afterEach(() => {
  cleanup();
  useBuilderStore.getState().closeDocument();
});

describe("HistoryBody", () => {
  it("marks the current step and jumps to any row, applied or undone", () => {
    render(<HistoryBody />);
    expect(screen.getByTestId("builder-op-list").querySelectorAll("li")).toHaveLength(3);
    expect(button("builder-history-step-3").getAttribute("aria-current")).toBe("step");
    expect(button("builder-history-step-1").getAttribute("aria-current")).toBeNull();
    expect(button("builder-history-step-1").title).toBe("Undo back to this step");
    // A click on the current step does nothing.
    fireEvent.click(button("builder-history-step-3"));
    expect(applied()).toBe(3);

    fireEvent.click(button("builder-history-step-1"));
    expect(applied()).toBe(1);
    // The undone steps follow, dimmed, numbered on from the applied ones.
    const undone = screen.getByTestId("builder-undone-list");
    expect(undone.getAttribute("start")).toBe("2");
    expect(undone.textContent).toBe("SecondThird");
    expect(button("builder-history-step-3").title).toBe("Redo up to this step");
    expect(button("builder-history-step-1").getAttribute("aria-current")).toBe("step");

    fireEvent.click(button("builder-history-step-3"));
    expect(applied()).toBe(3);
    expect(screen.queryByTestId("builder-undone-list")).toBeNull();
  });

  it("Undo all puts every step on the redo list; the rows bring them back", () => {
    render(<HistoryBody />);
    const all = button("builder-clear-ops");
    expect(all.textContent).toBe("Undo all");
    expect(all.title).toBe("Undo every edit; Redo brings them back");
    fireEvent.click(all);
    expect(applied()).toBe(0);
    expect(screen.queryByTestId("builder-op-list")).toBeNull();
    expect(screen.getByTestId("builder-undone-list").querySelectorAll("li")).toHaveLength(3);
    fireEvent.click(button("builder-history-step-2"));
    expect(applied()).toBe(2);
  });

  it("Show original is a toggle button, off while there is nothing to compare", () => {
    useBuilderStore.getState().clearOps();
    useBuilderStore.setState({ redoStack: [] });
    render(<HistoryBody />);
    const original = button("builder-show-original");
    expect(original.tagName).toBe("BUTTON");
    expect(original.disabled).toBe(true);
    expect(screen.getByText("No edits yet.")).toBeTruthy();
    act(() => useBuilderStore.getState().pushOp(move(0)));
    expect(original.disabled).toBe(false);
    expect(original.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(original);
    expect(useBuilderStore.getState().showOriginal).toBe(true);
    expect(original.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("builder-resume-editing"));
    expect(useBuilderStore.getState().showOriginal).toBe(false);
  });

  it("pauses Undo, Redo and the rows while the original or a preview is shown", () => {
    useBuilderStore.getState().undo();
    render(<HistoryBody />);
    act(() => useBuilderStore.getState().setShowOriginal(true));
    for (const id of ["builder-undo", "builder-redo", "builder-clear-ops"]) {
      expect(button(id).disabled).toBe(true);
      expect(button(id).title).toContain("Show original");
    }
    expect(button("builder-history-step-1").disabled).toBe(true);
    expect(button("builder-history-step-1").title).toContain("Show original");
    // Show original itself stays on, to turn it off.
    expect(button("builder-show-original").disabled).toBe(false);

    act(() => useBuilderStore.getState().setShowOriginal(false));
    act(() => useBuilderStore.getState().setPreview({ op: "wrap" }));
    expect(button("builder-undo").disabled).toBe(true);
    expect(button("builder-undo").title).toContain("preview");
    act(() => useBuilderStore.getState().setPreview(null));
    expect(button("builder-undo").disabled).toBe(false);
    expect(button("builder-undo").title).toBe("");
    fireEvent.click(button("builder-undo"));
    expect(applied()).toBe(1);
    fireEvent.click(button("builder-redo"));
    expect(applied()).toBe(2);
  });

  it("lists the engine's warnings", () => {
    act(() => useBuilderStore.getState().pushOp({ op: "delete_atoms", atoms: [99] }));
    render(<HistoryBody />);
    expect(screen.getByTestId("builder-warnings").textContent).toContain("99");
  });
});
