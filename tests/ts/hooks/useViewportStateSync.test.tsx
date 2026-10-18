import { describe, expect, it, vi, beforeEach } from "vitest";
import { useEffect, useRef } from "react";
import { render, act } from "@testing-library/react";
import { createStore } from "zustand/vanilla";

vi.mock("@/pipeline/apply", () => ({ applyViewportState: vi.fn() }));

import { applyViewportState } from "@/pipeline/apply";
import {
  countViewportBonds,
  useViewportStateSync,
  type ViewportStateHolder,
  type ViewportStateSyncOptions,
} from "@/hooks/useViewportStateSync";
import { DEFAULT_VIEWPORT_STATE } from "@/pipeline/types";
import type { BondData, FrameProvider, ViewportState } from "@/pipeline/types";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { Snapshot } from "@/types";

const mockApply = vi.mocked(applyViewportState);

function makeSnapshot(nAtoms: number): Snapshot {
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms).fill(6),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
  };
}

function makeRenderer() {
  return { applyCameraState: vi.fn() } as unknown as MoleculeRenderer & {
    applyCameraState: ReturnType<typeof vi.fn>;
  };
}

function bonds(nPairs: number): BondData {
  return { bondIndices: new Uint32Array(nPairs * 2) } as unknown as BondData;
}

type Opts = Omit<ViewportStateSyncOptions, "snapshot">;

function setup(initialSnapshot: Snapshot | null, opts: Opts = {}) {
  const store = createStore<ViewportStateHolder>(() => ({
    viewportState: { ...DEFAULT_VIEWPORT_STATE },
  }));
  let renders = 0;
  let attach: ((r: MoleculeRenderer) => void) | null = null;

  function Host({
    snapshot,
    renderer,
    hostOpts,
  }: {
    snapshot: Snapshot | null;
    renderer?: MoleculeRenderer;
    hostOpts: Opts;
  }) {
    renders++;
    const rendererRef = useRef<MoleculeRenderer | null>(null);
    const { attachRenderer } = useViewportStateSync(rendererRef, store, {
      snapshot,
      ...hostOpts,
    });
    attach = attachRenderer;
    return renderer ? <Child renderer={renderer} onReady={attachRenderer} /> : null;
  }

  // Stands in for the Viewport: hands over its renderer from a mount-once
  // child effect, which runs before the host's effects in the same commit.
  function Child({
    renderer,
    onReady,
  }: {
    renderer: MoleculeRenderer;
    onReady: (r: MoleculeRenderer) => void;
  }) {
    useEffect(() => onReady(renderer), []); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  }

  const utils = render(<Host snapshot={initialSnapshot} hostOpts={opts} />);
  return {
    store,
    utils,
    get renders() {
      return renders;
    },
    attach: (r: MoleculeRenderer) => act(() => attach!(r)),
    rerender: (snapshot: Snapshot | null, renderer?: MoleculeRenderer, hostOpts: Opts = opts) =>
      utils.rerender(<Host snapshot={snapshot} renderer={renderer} hostOpts={hostOpts} />),
    setViewportState: (vs: Partial<ViewportState>) =>
      act(() => store.setState({ viewportState: { ...store.getState().viewportState, ...vs } })),
  };
}

describe("countViewportBonds", () => {
  it("sums bond pairs across streams", () => {
    expect(countViewportBonds([])).toBe(0);
    expect(countViewportBonds([bonds(2), bonds(3)])).toBe(5);
  });
});

describe("useViewportStateSync", () => {
  beforeEach(() => mockApply.mockClear());

  it("applies the full state when a renderer attaches", () => {
    const h = setup(null);
    const renderer = makeRenderer();
    h.attach(renderer);
    expect(mockApply).toHaveBeenCalled();
    const [r, current, previous] = mockApply.mock.calls[0];
    expect(r).toBe(renderer);
    expect(current).toBe(h.store.getState().viewportState);
    expect(previous).toBeNull();
  });

  it("applies later states as a diff without re-rendering the host", () => {
    const h = setup(null);
    h.attach(makeRenderer());
    const first = h.store.getState().viewportState;
    const rendersBefore = h.renders;
    mockApply.mockClear();

    h.setViewportState({ bonds: [] });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][1]).toBe(h.store.getState().viewportState);
    expect(mockApply.mock.calls[0][2]).toBe(first);
    expect(h.renders).toBe(rendersBefore);
  });

  it("does nothing on a viewport change before a renderer exists", () => {
    const h = setup(null);
    mockApply.mockClear();
    h.setViewportState({ bonds: [] });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("re-applies in full and restores the camera once on the first snapshot", () => {
    const camera = { mode: "orthographic" } as never;
    const getInitialCameraState = vi.fn(() => camera);
    const h = setup(null, { getInitialCameraState });
    const renderer = makeRenderer();
    h.attach(renderer);
    mockApply.mockClear();

    const snapA = makeSnapshot(2);
    h.rerender(snapA);
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][2]).toBeNull();
    expect(renderer.applyCameraState).toHaveBeenCalledWith(camera);

    // Same snapshot again: nothing to do.
    mockApply.mockClear();
    h.rerender(snapA);
    expect(mockApply).not.toHaveBeenCalled();

    // A new snapshot re-applies in full but never restores the camera again.
    h.rerender(makeSnapshot(3));
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][2]).toBeNull();
    expect(renderer.applyCameraState).toHaveBeenCalledTimes(1);
    expect(getInitialCameraState).toHaveBeenCalledTimes(1);
  });

  it("skips the restore when the host has no saved camera", () => {
    const h = setup(null, { getInitialCameraState: () => null });
    const renderer = makeRenderer();
    h.attach(renderer);
    h.rerender(makeSnapshot(2));
    expect(renderer.applyCameraState).not.toHaveBeenCalled();
  });

  it("re-applies after a renderer mounted together with its snapshot", () => {
    // The Viewport attaches its renderer before running loadSnapshot (which
    // resets per-atom overrides), and the snapshot did not change in that
    // commit — the hook must still re-apply once the child effects are done.
    const snap = makeSnapshot(2);
    const camera = { mode: "orthographic" } as never;
    const h = setup(snap, { getInitialCameraState: () => camera });
    expect(mockApply).not.toHaveBeenCalled();

    const renderer = makeRenderer();
    act(() => {
      h.rerender(snap, renderer);
    });
    // attach (full) + post-commit re-apply (full).
    expect(mockApply).toHaveBeenCalledTimes(2);
    expect(mockApply.mock.calls.every((c) => c[2] === null)).toBe(true);
    expect(renderer.applyCameraState).toHaveBeenCalledWith(camera);

    // Later commits with nothing new do not re-apply.
    mockApply.mockClear();
    h.rerender(snap, renderer);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("routes the primary node through getPrimaryNodeId", () => {
    let primary: string | null | undefined = "load_structure-1";
    const h = setup(null, { getPrimaryNodeId: () => primary });
    h.attach(makeRenderer());
    expect(mockApply.mock.calls[0][3]).toBe("load_structure-1");
    primary = undefined;
    h.setViewportState({ bonds: [] });
    expect(mockApply.mock.lastCall?.[3]).toBeUndefined();
  });

  it("reports the bond total only when the bond streams change", () => {
    const onBondCount = vi.fn();
    const h = setup(null, { onBondCount });
    expect(onBondCount).toHaveBeenCalledWith(0);
    onBondCount.mockClear();

    h.setViewportState({ bonds: [bonds(4)] });
    expect(onBondCount).toHaveBeenCalledWith(4);
    onBondCount.mockClear();

    // A change that leaves the bond streams alone does not report.
    h.setViewportState({ cells: [] });
    expect(onBondCount).not.toHaveBeenCalled();
  });

  it("hands over the first trajectory provider when it changes", () => {
    const onTrajectoryProvider = vi.fn();
    const h = setup(null, { onTrajectoryProvider });
    // No trajectory at mount → nothing to report.
    expect(onTrajectoryProvider).not.toHaveBeenCalled();

    const provider = { meta: { nFrames: 3 } } as unknown as FrameProvider;
    const traj = { provider } as unknown as ViewportState["trajectories"][number];
    h.setViewportState({ trajectories: [traj] });
    expect(onTrajectoryProvider).toHaveBeenCalledWith(provider);

    onTrajectoryProvider.mockClear();
    h.setViewportState({ trajectories: [traj], bonds: [] });
    expect(onTrajectoryProvider).not.toHaveBeenCalled();

    h.setViewportState({ trajectories: [] });
    expect(onTrajectoryProvider).toHaveBeenCalledWith(null);
  });

  it("uses the latest callbacks without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const h = setup(null, { onBondCount: first });
    h.rerender(null, undefined, { onBondCount: second });
    h.setViewportState({ bonds: [bonds(1)] });
    expect(first).toHaveBeenCalledTimes(1); // the mount-time report only
    expect(second).toHaveBeenCalledWith(1);
  });

  it("unsubscribes on unmount", () => {
    const onBondCount = vi.fn();
    const h = setup(null, { onBondCount });
    h.utils.unmount();
    onBondCount.mockClear();
    h.setViewportState({ bonds: [bonds(2)] });
    expect(onBondCount).not.toHaveBeenCalled();
  });
});
