/**
 * Keeps a MoleculeRenderer in step with a pipeline's ViewportState.
 *
 * Shared by every viewer that renders a pipeline — MeganeViewer (webapp,
 * VSCode, JupyterLab DocWidget), WidgetViewer (Jupyter widget) and
 * PipelineViewer (docs / MDX embeds) — so the renderer sees the same sequence
 * of `applyViewportState` calls on every host:
 *
 * - `attachRenderer` (wire it into the Viewport's `onRendererReady`) applies
 *   the full current state to a freshly created renderer.
 * - Every new `viewportState` is applied as a diff against the previous one.
 *   The store is subscribed through its vanilla `subscribe`, NOT a React
 *   selector: a pipeline execute produces a new `viewportState` on every node
 *   edit, and a render-path subscription would re-render the whole viewer
 *   (Timeline, panels, …) for each one. Only the callbacks below run.
 * - When the snapshot handed to the Viewport changes identity, the Viewport's
 *   own `loadSnapshot` (a child effect, so it has already run) resets every
 *   per-atom override, so the full state is re-applied — and on the first
 *   non-null snapshot the host's persisted camera is restored, after the
 *   Viewport's fit-to-view instead of being overwritten by it.
 *
 * `atomLabels` is deliberately not forwarded: `applyViewportState` ignores
 * its fifth argument (`_atomLabels`) — label-dependent colours are resolved
 * by the color executors and arrive on the particle streams — so the copies
 * that passed it and the copies that dropped it behaved identically.
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { MeganeCameraState, MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { applyViewportState } from "../pipeline/apply";
import type { FrameProvider, ViewportState } from "../pipeline/types";
import type { Snapshot } from "../types";

/** The slice of a store the hook reads. A pipeline store satisfies it. */
export interface ViewportStateHolder {
  viewportState: ViewportState;
}

/** A zustand-style store API exposing a `viewportState`. */
export interface ViewportStateApi {
  getState(): ViewportStateHolder;
  subscribe(listener: (state: ViewportStateHolder, prev: ViewportStateHolder) => void): () => void;
}

export interface ViewportStateSyncOptions {
  /**
   * The snapshot the Viewport is currently showing. A change of identity
   * triggers a full re-apply (and, the first time it is non-null, the camera
   * restore).
   */
  snapshot: Snapshot | null;
  /**
   * The load_structure node whose particles the renderer's built-in meshes
   * draw — i.e. the node `snapshot` belongs to. Every other node is drawn as a
   * StructureLayer. Omitted or `undefined`: `applyViewportState` takes the
   * first particle stream's node, which is right whenever `snapshot` is
   * `viewportState.particles[0].source`.
   */
  getPrimaryNodeId?: () => string | null | undefined;
  /** Camera to restore once, on the first non-null snapshot. */
  getInitialCameraState?: () => MeganeCameraState | null | undefined;
  /** Called with the total pipeline bond count whenever the bond streams change. */
  onBondCount?: (count: number) => void;
  /** Called when the first trajectory stream's provider changes identity. */
  onTrajectoryProvider?: (provider: FrameProvider | null) => void;
}

export interface ViewportStateSync {
  /** Pass to `Viewport.onRendererReady` (or call from the host's own handler). */
  attachRenderer: (renderer: MoleculeRenderer) => void;
}

/** Number of bonds across every bond stream of a viewport state. */
export function countViewportBonds(bonds: ViewportState["bonds"]): number {
  return bonds.reduce((sum, b) => sum + b.bondIndices.length / 2, 0);
}

export function useViewportStateSync(
  rendererRef: MutableRefObject<MoleculeRenderer | null>,
  api: ViewportStateApi,
  opts: ViewportStateSyncOptions,
): ViewportStateSync {
  // Callbacks are read through a ref so a host passing fresh closures every
  // render never re-runs the subscription or the snapshot effect.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const prevStateRef = useRef<ViewportState | null>(null);
  const hasRestoredCameraRef = useRef(false);
  // The snapshot the last full re-apply ran for (`undefined`: none yet), and
  // whether a renderer was attached since. The Viewport calls
  // `onRendererReady` from its mount effect *before* its snapshot effect runs
  // `loadSnapshot`, so a renderer mounted together with its first snapshot
  // needs the re-apply in that same commit even though `snapshot` itself may
  // not have changed in it.
  const appliedSnapshotRef = useRef<Snapshot | null | undefined>(undefined);
  const attachedSinceApplyRef = useRef(false);

  const apply = useCallback((renderer: MoleculeRenderer, vs: ViewportState, full: boolean) => {
    applyViewportState(
      renderer,
      vs,
      full ? null : prevStateRef.current,
      optsRef.current.getPrimaryNodeId?.(),
    );
    prevStateRef.current = vs;
  }, []);

  const attachRenderer = useCallback(
    (renderer: MoleculeRenderer) => {
      rendererRef.current = renderer;
      attachedSinceApplyRef.current = true;
      apply(renderer, api.getState().viewportState, true);
    },
    [rendererRef, api, apply],
  );

  // Runs after every commit (no deps) but only acts on a new snapshot or a
  // newly attached renderer; child effects — the Viewport's `loadSnapshot` —
  // have already run by then.
  const { snapshot } = opts;
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (snapshot === appliedSnapshotRef.current && !attachedSinceApplyRef.current) return;
    appliedSnapshotRef.current = snapshot;
    attachedSinceApplyRef.current = false;
    apply(renderer, api.getState().viewportState, true);
    if (snapshot && !hasRestoredCameraRef.current) {
      hasRestoredCameraRef.current = true;
      const saved = optsRef.current.getInitialCameraState?.();
      if (saved) renderer.applyCameraState(saved);
    }
  });

  useEffect(() => {
    let prevBonds: ViewportState["bonds"] | null = null;
    let prevProvider: FrameProvider | null = null;

    const sync = (vs: ViewportState) => {
      const renderer = rendererRef.current;
      if (renderer) apply(renderer, vs, false);

      if (vs.bonds !== prevBonds) {
        prevBonds = vs.bonds;
        optsRef.current.onBondCount?.(countViewportBonds(vs.bonds));
      }

      const provider = vs.trajectories[0]?.provider ?? null;
      if (provider !== prevProvider) {
        prevProvider = provider;
        optsRef.current.onTrajectoryProvider?.(provider);
      }
    };

    sync(api.getState().viewportState);
    return api.subscribe((state, prev) => {
      if (state.viewportState !== prev.viewportState) sync(state.viewportState);
    });
  }, [api, rendererRef, apply]);

  return { attachRenderer };
}
