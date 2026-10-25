/**
 * Picking an atom in the Inspector describes it from the snapshot on screen,
 * residue name included: the labels ride on that snapshot, as the Filter node
 * reads them, rather than on a store field no host sets.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

vi.mock("@/components/Viewport", () => ({ Viewport: vi.fn(() => null) }));
vi.mock("@/components/Tooltip", () => ({ Tooltip: vi.fn(() => null) }));
vi.mock("@/components/MeasurementPanel", () => ({ MeasurementPanel: vi.fn(() => null) }));
vi.mock("@/components/Timeline", () => ({ Timeline: vi.fn(() => null) }));
vi.mock("@/components/PipelineEditor", () => ({ PipelineEditor: vi.fn(() => null) }));

import { MeganeViewer } from "@/components/MeganeViewer";
import { Viewport } from "@/components/Viewport";
import { usePipelineStore } from "@/pipeline/store";
import { useInspectorInteractionStore } from "@/stores/useInspectorInteractionStore";
import type { Snapshot } from "@/types";

const water: Snapshot = {
  nAtoms: 3,
  nBonds: 2,
  nFileBonds: 2,
  positions: new Float32Array([0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0]),
  elements: new Uint8Array([8, 1, 1]),
  bonds: new Uint32Array([0, 1, 0, 2]),
  bondOrders: null,
  box: null,
  atomChainIds: new Uint8Array([65, 65, 65]),
  atomBFactors: null,
};

afterEach(() => {
  cleanup();
  usePipelineStore.getState().reset();
  useInspectorInteractionStore.setState({ pickedAtom: null });
});

describe("MeganeViewer — Inspector pick", () => {
  it("names the residue of a picked atom from a file opened in a loader", () => {
    const store = usePipelineStore.getState();
    const loaderId = store.nodes.find((n) => n.type === "load_structure")!.id;
    store.setNodeSnapshot(loaderId, {
      snapshot: water,
      frames: null,
      meta: null,
      labels: ["HOH1", "HOH1", "HOH1"],
    });
    render(<MeganeViewer onUploadStructure={() => {}} />);
    const props = vi.mocked(Viewport).mock.calls.at(-1)![0];
    act(() => props.onInspectorPick?.(1));
    expect(useInspectorInteractionStore.getState().pickedAtom).toMatchObject({
      index: 1,
      element: "H",
      resname: "HOH",
      chain: "A",
      moleculeId: 0,
    });
  });

  it("ignores a pick with nothing loaded", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    const props = vi.mocked(Viewport).mock.calls.at(-1)![0];
    act(() => props.onInspectorPick?.(0));
    expect(useInspectorInteractionStore.getState().pickedAtom).toBeNull();
  });
});
