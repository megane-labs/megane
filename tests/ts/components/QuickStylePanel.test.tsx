import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { createPipelineStore } from "@/pipeline/store";
import { QuickStylePanel } from "@/components/QuickStylePanel";
import { QUICK_STYLE_IDS } from "@/pipeline/quickStyle";
import type { Snapshot } from "@/types";
import type {
  AddBondParams,
  ColorParams,
  LabelGeneratorParams,
  ModifyParams,
  ViewportParams,
} from "@/pipeline/types";

function snapshot(withCell = false): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    nFileBonds: 1,
    positions: new Float32Array([0, 0, 0, 1.2, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box: withCell ? new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]) : null,
    boxOrigin: null,
  } as unknown as Snapshot;
}

function loadedStore(withCell = false) {
  const store = createPipelineStore();
  store.getState().setNodeSnapshot("loader-1", {
    snapshot: snapshot(withCell),
    frames: null,
    meta: null,
    labels: null,
  });
  return store;
}

function node<T>(store: ReturnType<typeof createPipelineStore>, id: string): T | undefined {
  return store.getState().nodes.find((n) => n.id === id)?.data.params as T | undefined;
}

afterEach(cleanup);

describe("QuickStylePanel", () => {
  it("writes atom size into a Quick Style modify node and reads it back", () => {
    const store = loadedStore();
    const onApplied = vi.fn();
    render(<QuickStylePanel store={store} onApplied={onApplied} />);
    fireEvent.change(screen.getByTestId("quick-style-atom-scale"), { target: { value: "0.5" } });
    expect(node<ModifyParams>(store, QUICK_STYLE_IDS.atoms)?.scale).toBe(0.5);
    expect((screen.getByTestId("quick-style-atom-scale") as HTMLInputElement).value).toBe("0.5");
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("styles bonds, color, representation and labels", () => {
    const store = loadedStore();
    render(<QuickStylePanel store={store} />);
    fireEvent.change(screen.getByTestId("quick-style-bond-scale"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("quick-style-bond-opacity"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByTestId("quick-style-atom-opacity"), { target: { value: "0.3" } });
    fireEvent.change(screen.getByTestId("quick-style-color"), { target: { value: "uniform" } });
    fireEvent.change(screen.getByTestId("quick-style-color-value"), {
      target: { value: "#00ff00" },
    });
    fireEvent.change(screen.getByTestId("quick-style-rep"), { target: { value: "licorice" } });
    fireEvent.click(screen.getByTestId("quick-style-labels-element"));

    expect(node<ModifyParams>(store, QUICK_STYLE_IDS.bonds)).toMatchObject({
      scale: 2,
      opacity: 0.5,
    });
    expect(node<ModifyParams>(store, QUICK_STYLE_IDS.atoms)?.opacity).toBe(0.3);
    expect(node<ColorParams>(store, QUICK_STYLE_IDS.color)).toMatchObject({
      mode: "uniform",
      uniformColor: "#00ff00",
    });
    expect(node(store, QUICK_STYLE_IDS.representation)).toMatchObject({ mode: "licorice" });
    expect(node<LabelGeneratorParams>(store, QUICK_STYLE_IDS.labels)?.source).toBe("element");

    // Back to the pipeline default removes the node again.
    fireEvent.change(screen.getByTestId("quick-style-rep"), { target: { value: "" } });
    expect(node(store, QUICK_STYLE_IDS.representation)).toBeUndefined();
  });

  it("toggles perspective and, with a cell, the cell axes", () => {
    const store = loadedStore(true);
    render(<QuickStylePanel store={store} />);
    fireEvent.click(screen.getByTestId("quick-style-perspective"));
    fireEvent.click(screen.getByTestId("quick-style-cell-axes"));
    expect(node<ViewportParams>(store, "viewport-1")).toMatchObject({
      perspective: true,
      cellAxesVisible: false,
    });
  });

  it("hides the cell-axes toggle without a cell and disables residue labels without them", () => {
    const store = loadedStore(false);
    render(<QuickStylePanel store={store} />);
    expect(screen.queryByTestId("quick-style-cell-axes")).toBeNull();
    expect((screen.getByTestId("quick-style-labels-resname") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows the bond tolerance only for distance-inferred bonds", () => {
    const store = loadedStore();
    render(<QuickStylePanel store={store} />);
    expect(screen.queryByTestId("quick-style-bond-tolerance")).toBeNull();
    act(() => {
      store.getState().updateNodeParams("addbond-1", {
        type: "add_bond",
        bondSource: "distance",
      } as AddBondParams);
    });
    fireEvent.change(screen.getByTestId("quick-style-bond-tolerance"), {
      target: { value: "0.8" },
    });
    expect(node<AddBondParams>(store, "addbond-1")?.vdwScale).toBe(0.8);
  });

  it("resets every control", () => {
    const store = loadedStore();
    render(<QuickStylePanel store={store} />);
    fireEvent.change(screen.getByTestId("quick-style-atom-scale"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByTestId("quick-style-labels-index"));
    fireEvent.click(screen.getByTestId("quick-style-reset"));
    expect(store.getState().nodes.some((n) => n.id.startsWith("insp-global-"))).toBe(false);
  });

  it("hints at style nodes it does not own", () => {
    const store = loadedStore();
    store.getState().addNode("color", { x: 0, y: 0 });
    render(<QuickStylePanel store={store} />);
    expect(screen.getByTestId("quick-style-foreign-hint").textContent).toMatch(
      /1 other style node/,
    );
  });

  it("explains a missing viewport and a host-provided reason", () => {
    const store = createPipelineStore();
    store.setState({ nodes: [], edges: [] });
    const { rerender } = render(<QuickStylePanel store={store} />);
    expect(screen.getByText(/Add a Viewport node/)).toBeTruthy();
    rerender(<QuickStylePanel store={store} framed={false} disabledReason="Not here." />);
    expect(screen.getByTestId("quick-style-disabled").textContent).toBe("Not here.");
  });
});
