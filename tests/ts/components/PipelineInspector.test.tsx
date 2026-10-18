import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { useInspectorInteractionStore } from "@/stores/useInspectorInteractionStore";
import { PipelineInspector } from "@/components/PipelineInspector";
import { isInspectorId, defaultInspectorAppearance } from "@/pipeline/inspectorSync";
import type { Snapshot } from "@/types";
import type { FilterParams, ColorParams } from "@/pipeline/types";

function tinySnapshot(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    elements: new Uint8Array([6, 7, 8]), // C, N, O
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: new Uint8Array([65, 65, 66]), // A, A, B
    atomBFactors: null,
  };
}

function inspectorNodes() {
  return usePipelineStore.getState().nodes.filter((n) => isInspectorId(n.id));
}

describe("PipelineInspector", () => {
  beforeEach(() => {
    usePipelineStore.getState().setInspectorLayers([]);
    usePipelineStore.getState().setSnapshot(tinySnapshot());
    usePipelineStore.getState().setAtomLabels(["ALA1", "ALA1", "HOH2"]);
  });

  afterEach(() => {
    cleanup();
    usePipelineStore.getState().setInspectorLayers([]);
    usePipelineStore.getState().setSnapshot(null);
    usePipelineStore.getState().setAtomLabels(null);
  });

  it("prompts to load a structure when none is present", () => {
    usePipelineStore.getState().setSnapshot(null);
    render(<PipelineInspector />);
    expect(screen.getByText(/Load a structure/i)).toBeTruthy();
  });

  it("renders element/residue/chain chips from the loaded structure", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    // Elements C/N/O present.
    expect(screen.getByTestId("inspector-chip-element-C")).toBeTruthy();
    expect(screen.getByTestId("inspector-chip-element-N")).toBeTruthy();
    // Residues from labels.
    expect(screen.getByTestId("inspector-chip-resname-ALA")).toBeTruthy();
    expect(screen.getByTestId("inspector-chip-resname-HOH")).toBeTruthy();
    // Chains.
    expect(screen.getByTestId("inspector-chip-chain-A")).toBeTruthy();
    expect(screen.getByTestId("inspector-chip-chain-B")).toBeTruthy();
  });

  it("adding a layer creates Inspector-owned pipeline nodes (reflected in the graph)", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    const nodes = inspectorNodes();
    // Filter (always) + color (default appearance has color on).
    expect(nodes.some((n) => n.type === "filter")).toBe(true);
    expect(nodes.some((n) => n.type === "color")).toBe(true);
  });

  it("clicking an element chip writes the selection query into the filter node", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.click(screen.getByTestId("inspector-chip-element-C"));

    const filter = inspectorNodes().find((n) => n.type === "filter");
    expect(filter).toBeDefined();
    expect((filter!.data.params as FilterParams).query).toBe('element == "C"');
    // Live count reflects the single carbon.
    expect(screen.getByTestId("inspector-selected-count").textContent).toContain("1 atom");
  });

  it("editing the raw expression updates the filter query", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.change(screen.getByTestId("inspector-query"), {
      target: { value: 'element != "H"' },
    });
    const filter = inspectorNodes().find((n) => n.type === "filter");
    expect((filter!.data.params as FilterParams).query).toBe('element != "H"');
  });

  it("changing the uniform color updates the color node", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.change(screen.getByTestId("inspector-color-value"), {
      target: { value: "#112233" },
    });
    const color = inspectorNodes().find((n) => n.type === "color");
    expect((color!.data.params as ColorParams).uniformColor).toBe("#112233");
  });

  it("deleting a layer removes its nodes from the graph", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    expect(inspectorNodes().length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("inspector-delete-layer-1"));
    expect(inspectorNodes().length).toBe(0);
  });

  it("shows a validation error for a malformed expression", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.change(screen.getByTestId("inspector-query"), {
      target: { value: "element ==" },
    });
    // Count label switches to the parser error message.
    expect(screen.getByTestId("inspector-selected-count").textContent).not.toContain("atom");
  });
});

describe("PipelineInspector — 3D interactions", () => {
  beforeEach(() => {
    usePipelineStore.getState().setInspectorLayers([]);
    usePipelineStore.getState().setSnapshot(tinySnapshot());
    usePipelineStore.getState().setAtomLabels(["ALA1", "ALA1", "HOH2"]);
    usePipelineUIStore.getState().setMode("inspector");
    useInspectorInteractionStore.setState({
      previewIndices: null,
      boxSelectActive: false,
      boxResult: null,
      pickedAtom: null,
    });
  });

  afterEach(() => {
    cleanup();
    usePipelineUIStore.getState().setMode("editor");
    usePipelineStore.getState().setInspectorLayers([]);
    usePipelineStore.getState().setSnapshot(null);
    usePipelineStore.getState().setAtomLabels(null);
  });

  it("publishes a live preview of the active selection to the 3D bridge", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.click(screen.getByTestId("inspector-chip-element-N"));
    // The nitrogen atom is index 1.
    expect(useInspectorInteractionStore.getState().previewIndices).toEqual([1]);
  });

  it("consumes a completed box selection into the active layer's expression", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    act(() => {
      useInspectorInteractionStore.getState().publishBoxResult([0, 2]);
    });
    const filter = inspectorNodes().find((n) => n.type === "filter");
    expect((filter!.data.params as FilterParams).query).toBe("index == 0 or index == 2");
    // Box mode auto-disarms after a selection.
    expect(useInspectorInteractionStore.getState().boxSelectActive).toBe(false);
  });

  it("quick-expands a clicked atom to a same-element selection", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    act(() => {
      useInspectorInteractionStore.getState().publishPickedAtom({
        index: 0,
        element: "C",
        resname: "ALA",
        chain: "A",
        moleculeId: null,
      });
    });
    fireEvent.click(screen.getByTestId("inspector-quick-element"));
    const filter = inspectorNodes().find((n) => n.type === "filter");
    expect((filter!.data.params as FilterParams).query).toBe('element == "C"');
  });

  it("toggles box-select mode on the bridge store", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.click(screen.getByTestId("inspector-box-toggle"));
    expect(useInspectorInteractionStore.getState().boxSelectActive).toBe(true);
  });

  it("shows the Quick Style section above the selections", () => {
    render(<PipelineInspector />);
    expect(screen.getByTestId("quick-style")).toBeTruthy();
    usePipelineStore.getState().setSnapshot(null);
  });

  it("follows layers that reach the graph from outside the panel", () => {
    render(<PipelineInspector />);
    expect(screen.queryByTestId("inspector-layer-layer-3")).toBeNull();
    // e.g. a re-opened .megane.json or an Editor edit, not a click here.
    act(() => {
      usePipelineStore.getState().setInspectorLayers([
        {
          id: "layer-3",
          name: "ignored",
          query: 'element == "N"',
          appearance: defaultInspectorAppearance(),
        },
      ]);
    });
    expect(screen.getByTestId("inspector-layer-layer-3").textContent).toContain("Layer 3");
    act(() => {
      usePipelineStore.getState().setInspectorLayers([]);
    });
    expect(screen.queryByTestId("inspector-layer-layer-3")).toBeNull();
  });

  it("deleting the active layer selects the remaining one", () => {
    render(<PipelineInspector />);
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.click(screen.getByTestId("inspector-add-layer"));
    fireEvent.click(screen.getByTestId("inspector-delete-layer-2"));
    expect(screen.queryByTestId("inspector-layer-layer-2")).toBeNull();
    expect(screen.getByTestId("inspector-selection")).toBeTruthy();
  });
});
