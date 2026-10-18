/**
 * MeganeViewer on useViewportStateSync: first-snapshot camera restore (host
 * override vs. the view-state store), primary-node routing, and the
 * trajectory provider hand-off to the playback store.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

vi.mock("@/components/Viewport", () => ({ Viewport: vi.fn(() => null) }));
vi.mock("@/components/Tooltip", () => ({ Tooltip: vi.fn(() => null) }));
vi.mock("@/components/MeasurementPanel", () => ({ MeasurementPanel: vi.fn(() => null) }));
vi.mock("@/components/Timeline", () => ({ Timeline: vi.fn(() => null) }));
vi.mock("@/components/PipelineEditor", () => ({ PipelineEditor: vi.fn(() => null) }));
vi.mock("@/pipeline/apply", () => ({
  applyViewportState: vi.fn(),
  applyVectorsForFrame: vi.fn(),
}));

import { MeganeViewer } from "@/components/MeganeViewer";
import { Viewport } from "@/components/Viewport";
import { MeganeProvider } from "@/stores/MeganeProvider";
import { createMeganeStores, type MeganeStores } from "@/stores/meganeStores";
import { applyViewportState } from "@/pipeline/apply";
import { MemoryFrameProvider } from "@/pipeline/types";
import type { MeganeCameraState, MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { Frame, Snapshot } from "@/types";

const mockViewport = vi.mocked(Viewport);
const mockApply = vi.mocked(applyViewportState);

const snapshot: Snapshot = {
  nAtoms: 1,
  nBonds: 0,
  nFileBonds: 0,
  positions: new Float32Array([0, 0, 0]),
  elements: new Uint8Array([6]),
  bonds: new Uint32Array(0),
  bondOrders: null,
  box: null,
};
const camera = {
  mode: "orthographic",
  position: [1, 2, 3],
  target: [0, 0, 0],
  zoom: 2,
} as unknown as MeganeCameraState;

function makeRenderer() {
  const applyCameraState = vi.fn();
  const renderer = new Proxy(
    {},
    { get: (_t, prop) => (prop === "applyCameraState" ? applyCameraState : vi.fn()) },
  ) as unknown as MoleculeRenderer;
  return { renderer, applyCameraState };
}

function mount(stores: MeganeStores, initialCameraState?: MeganeCameraState | null) {
  render(
    <MeganeProvider stores={stores}>
      <MeganeViewer onUploadStructure={() => {}} initialCameraState={initialCameraState} />
    </MeganeProvider>,
  );
  const { renderer, applyCameraState } = makeRenderer();
  act(() => mockViewport.mock.lastCall![0].onRendererReady!(renderer));
  return { applyCameraState };
}

function loadStructure(stores: MeganeStores) {
  const loader = stores.pipeline.getState().nodes.find((n) => n.type === "load_structure")!;
  act(() =>
    stores.pipeline.getState().setNodeSnapshot(loader.id, {
      snapshot,
      frames: null,
      meta: null,
      labels: null,
    } as never),
  );
  return loader.id;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MeganeViewer viewport sync", () => {
  it("restores the host's camera on the first snapshot and routes the primary loader", () => {
    const stores = createMeganeStores();
    const { applyCameraState } = mount(stores, camera);
    expect(applyCameraState).not.toHaveBeenCalled();

    const loaderId = loadStructure(stores);
    expect(mockViewport.mock.lastCall![0].snapshot).toBe(snapshot);
    expect(applyCameraState).toHaveBeenCalledTimes(1);
    expect(applyCameraState).toHaveBeenCalledWith(camera);
    expect(mockApply.mock.lastCall?.[3]).toBe(loaderId);
    stores.destroy();
  });

  it("falls back to the view-state store's camera without a host override", () => {
    const stores = createMeganeStores();
    act(() => stores.viewState.getState().updateCamera(camera));
    const { applyCameraState } = mount(stores);
    loadStructure(stores);
    expect(applyCameraState).toHaveBeenCalledWith(camera);
    stores.destroy();
  });

  it("hands the pipeline's trajectory provider to the playback store", () => {
    const stores = createMeganeStores();
    mount(stores, null);
    const frames: Frame[] = [0, 1, 2].map((i) => ({
      frameId: i,
      nAtoms: 1,
      positions: new Float32Array([i, 0, 0]),
    }));
    const provider = new MemoryFrameProvider(frames, {
      nFrames: 3,
      timestepPs: 1,
      nAtoms: 1,
    });
    const vs = stores.pipeline.getState().viewportState;
    act(() =>
      stores.pipeline.setState({
        viewportState: {
          ...vs,
          trajectories: [{ type: "trajectory", provider, meta: provider.meta, source: "file" }],
        } as never,
      }),
    );
    expect(stores.playback.getState().provider).toBe(provider);
    expect(stores.playback.getState().totalFrames).toBe(3);
    stores.destroy();
  });
});
