import { describe, it, expect, vi } from "vitest";
import { createMeganeStores, globalMeganeStores } from "@/stores/meganeStores";
import { usePipelineStore } from "@/pipeline/store";
import { usePlaybackStore } from "@/stores/usePlaybackStore";
import { useMeasurementStore } from "@/stores/useMeasurementStore";
import { useViewStateStore } from "@/stores/useViewStateStore";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { useInspectorInteractionStore } from "@/stores/useInspectorInteractionStore";
import { globalLoadHandlers } from "@/stores/loadHandlers";
import type { Measurement } from "@/types";

function distance(): Measurement {
  return { atoms: [0, 1], type: "distance", value: 1.5, label: "1.50 Å" };
}

describe("createMeganeStores", () => {
  it("hands out a distinct store object per bundle", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    expect(a.pipeline).not.toBe(b.pipeline);
    expect(a.playback).not.toBe(b.playback);
    expect(a.measurement).not.toBe(b.measurement);
    expect(a.viewState).not.toBe(b.viewState);
    expect(a.pipelineUI).not.toBe(b.pipelineUI);
    expect(a.inspector).not.toBe(b.inspector);
    expect(a.loadHandlers).not.toBe(b.loadHandlers);
    expect(a.id).not.toBe(b.id);
  });

  it("gives each bundle its own initial graph rather than sharing node objects", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    const aNodes = a.pipeline.getState().nodes;
    const bNodes = b.pipeline.getState().nodes;

    expect(aNodes.length).toBeGreaterThan(0);
    expect(aNodes).not.toBe(bNodes);
    // Node objects must not be aliases either — a shared default graph is how
    // two viewers end up mutating each other's nodes.
    expect(aNodes[0]).not.toBe(bNodes[0]);
  });

  it("keeps a pipeline edit in one bundle out of the other — the #672 repro", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    const addedToA = a.pipeline.getState().addNode("color");

    expect(a.pipeline.getState().nodes.some((n) => n.id === addedToA)).toBe(true);
    expect(b.pipeline.getState().nodes.some((n) => n.id === addedToA)).toBe(false);
  });

  it("isolates a snapshot written into one bundle", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    a.pipeline.getState().setAtomLabels(["ALA", "GLY"]);

    expect(a.pipeline.getState().atomLabels).toEqual(["ALA", "GLY"]);
    expect(b.pipeline.getState().atomLabels).toBeNull();
  });

  it("isolates playback state", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    a.playback.getState().setFps(60);

    expect(a.playback.getState().fps).toBe(60);
    expect(b.playback.getState().fps).toBe(30);
  });

  it("isolates the measurement list", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    a.measurement.getState().addMeasurement(distance());

    expect(a.measurement.getState().measurements).toHaveLength(1);
    expect(b.measurement.getState().measurements).toHaveLength(0);
  });

  it("isolates the Inspector bridge so a pick lands in one viewer only", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    a.inspector.getState().setPreviewIndices([1, 2, 3]);

    expect(a.inspector.getState().previewIndices).toEqual([1, 2, 3]);
    expect(b.inspector.getState().previewIndices).toBeNull();
  });

  it("isolates the panel tab", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();

    a.pipelineUI.getState().setMode("editor");

    expect(a.pipelineUI.getState().mode).toBe("editor");
    expect(b.pipelineUI.getState().mode).toBe("chat");
  });

  it("isolates the file-drop slots so a drop on one viewer does not reach the other", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();
    const onA = vi.fn();
    const onB = vi.fn();

    a.loadHandlers.setStructure(onA);
    b.loadHandlers.setStructure(onB);

    const file = new File(["x"], "s.pdb");
    a.loadHandlers.structure?.("loader-1", file);

    expect(onA).toHaveBeenCalledWith("loader-1", file);
    expect(onB).not.toHaveBeenCalled();
  });

  it("leaves the surviving viewer's slot intact when the other clears its own", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();
    const onA = vi.fn();

    a.loadHandlers.setStructure(onA);
    b.loadHandlers.setStructure(vi.fn());
    // b unmounts
    b.loadHandlers.setStructure(null);

    a.loadHandlers.structure?.("loader-1", new File(["x"], "s.pdb"));
    expect(onA).toHaveBeenCalledTimes(1);
  });

  describe("persistence", () => {
    it("keeps camera state in memory by default so two viewers cannot collide", () => {
      const stores = createMeganeStores();
      const setItem = vi.spyOn(Storage.prototype, "setItem");

      stores.viewState.getState().updateCamera({ foo: 1 } as never);

      expect(stores.viewState.getState().camera).toEqual({ foo: 1 });
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    });

    it("persists the camera under the key it is given", () => {
      const stores = createMeganeStores({ persist: { camera: "megane-view-state-left" } });
      const setItem = vi.spyOn(Storage.prototype, "setItem");

      stores.viewState.getState().updateCamera({ foo: 1 } as never);

      expect(setItem).toHaveBeenCalledWith(
        "megane-view-state-left",
        JSON.stringify({ camera: { foo: 1 } }),
      );
      setItem.mockRestore();
    });

    it("keeps the panel tab in memory by default", () => {
      const stores = createMeganeStores();
      const setItem = vi.spyOn(Storage.prototype, "setItem");

      stores.pipelineUI.getState().setMode("editor");

      expect(stores.pipelineUI.getState().mode).toBe("editor");
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    });
  });

  it("stops the playback interval on destroy", () => {
    vi.useFakeTimers();
    const stores = createMeganeStores();
    stores.playback.getState().setProvider({
      kind: "memory",
      meta: { nFrames: 10, timestepPs: 1, nAtoms: 2 },
      getFrame: (i: number) => ({ frameId: i, nAtoms: 2, positions: new Float32Array(6) }),
    } as never);
    stores.playback.getState().play();
    expect(stores.playback.getState().playing).toBe(true);

    stores.destroy();
    const frameAfterDestroy = stores.playback.getState().currentFrame;
    vi.advanceTimersByTime(1000);

    expect(stores.playback.getState().currentFrame).toBe(frameAfterDestroy);
    vi.useRealTimers();
  });
});

describe("globalMeganeStores", () => {
  it("wraps the module-level singletons so provider-less hosts are unchanged", () => {
    expect(globalMeganeStores.pipeline).toBe(usePipelineStore);
    expect(globalMeganeStores.playback).toBe(usePlaybackStore);
    expect(globalMeganeStores.measurement).toBe(useMeasurementStore);
    expect(globalMeganeStores.viewState).toBe(useViewStateStore);
    expect(globalMeganeStores.pipelineUI).toBe(usePipelineUIStore);
    expect(globalMeganeStores.inspector).toBe(useInspectorInteractionStore);
    expect(globalMeganeStores.loadHandlers).toBe(globalLoadHandlers);
    expect(globalMeganeStores.isGlobal).toBe(true);
  });

  it("is inert on destroy — the process-global bundle outlives every viewer", () => {
    expect(() => globalMeganeStores.destroy()).not.toThrow();
  });
});
