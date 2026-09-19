/**
 * One viewer's worth of mutable state.
 *
 * `MeganeViewer` reads module-global Zustand stores, which is why only one can
 * be mounted per page today: a second viewer opening a file replaces the
 * first's graph (issue #672). Everything a second viewer must NOT share lives
 * in the bundle below; `<MeganeProvider>` hands one to its subtree.
 *
 * Deliberately EXCLUDED, because these are page-level rather than per-viewer:
 *
 * - `useThemeStore` — hosts write the resolved theme to
 *   `document.documentElement`'s `data-theme`, and `src/styles/megane.css`
 *   defines its tokens on `:root` / `html[data-theme]`. Two viewers scoping
 *   this would fight over one DOM node; per-viewer theming is a CSS-scoping
 *   project, not a store split.
 * - `useAIConfigStore` — one API key and model per user.
 * - `useTourStore` — one driver.js overlay per document.
 *
 * Also excluded: the WASM init memos and the shared parse worker (must stay
 * global), and the `nextNodeId` / `nextToken` / `nextNoticeId` counters —
 * those exist to keep ids unique, and per-instance counters would hand both
 * viewers an id "1".
 */

import type { StoreApi } from "zustand";
import { createPipelineStore, usePipelineStore, type PipelineStore } from "../pipeline/store";
import { createPlaybackStore, usePlaybackStore, type PlaybackStore } from "./usePlaybackStore";
import {
  createMeasurementStore,
  useMeasurementStore,
  type MeasurementStore,
} from "./useMeasurementStore";
import {
  createViewStateStore,
  useViewStateStore,
  type ViewStateStore,
  type ViewStateStorage,
} from "./useViewStateStore";
import {
  createPipelineUIStore,
  usePipelineUIStore,
  type PipelineUIStore,
  type PipelineUIStorage,
} from "./usePipelineUIStore";
import {
  createInspectorInteractionStore,
  useInspectorInteractionStore,
  type InspectorInteractionStore,
} from "./useInspectorInteractionStore";
import { createLoadHandlers, globalLoadHandlers, type MeganeLoadHandlers } from "./loadHandlers";

export interface MeganeStores {
  /**
   * Stable identity. Namespaces the E2E store registry and appears on the
   * viewer root as `data-megane-instance`.
   */
  readonly id: string;
  /** True for the process-global bundle backing provider-less hosts. */
  readonly isGlobal: boolean;

  readonly pipeline: StoreApi<PipelineStore>;
  readonly playback: StoreApi<PlaybackStore>;
  readonly measurement: StoreApi<MeasurementStore>;
  readonly viewState: StoreApi<ViewStateStore>;
  readonly pipelineUI: StoreApi<PipelineUIStore>;
  readonly inspector: StoreApi<InspectorInteractionStore>;

  /** Per-viewer file-drop routing — see ./loadHandlers.ts. */
  readonly loadHandlers: MeganeLoadHandlers;

  /**
   * Stop this bundle's playback interval. `<MeganeProvider>` calls it on
   * unmount for bundles it created itself, never for injected ones, and never
   * for the global bundle.
   */
  destroy(): void;
}

export interface CreateMeganeStoresOptions {
  /** Stable id; auto-generated when omitted. */
  id?: string;
  /**
   * Where per-viewer UI state persists. Both default to `false` (in memory).
   * An anonymous instance has no stable identity across reloads, and silently
   * reusing the legacy keys is exactly the collision this bundle exists to
   * prevent — two viewers would overwrite each other's saved camera and tab.
   * Pass keys explicitly to opt in.
   */
  persist?: {
    /** localStorage key for the camera, or `false` for in-memory. */
    camera?: ViewStateStorage;
    /** sessionStorage key for the panel tab, or `false` for in-memory. */
    pipelineUI?: PipelineUIStorage;
  };
}

let nextBundleId = 1;

/**
 * Build an isolated store bundle — one per `<MeganeViewer>` that must not
 * share state with its siblings.
 *
 * @example
 * const stores = createMeganeStores();
 * void stores.pipeline.getState().openFile(new File([text], "protein.pdb"));
 * <MeganeProvider stores={stores}><MeganeViewer … /></MeganeProvider>
 */
export function createMeganeStores(options: CreateMeganeStoresOptions = {}): MeganeStores {
  const id = options.id ?? `megane-${nextBundleId++}`;
  const playback = createPlaybackStore();

  return {
    id,
    isGlobal: false,
    pipeline: createPipelineStore(),
    playback,
    measurement: createMeasurementStore(),
    viewState: createViewStateStore(options.persist?.camera ?? false),
    pipelineUI: createPipelineUIStore(options.persist?.pipelineUI ?? false),
    inspector: createInspectorInteractionStore(),
    loadHandlers: createLoadHandlers(),
    destroy() {
      // Leaving the interval running would keep advancing frames — and hold a
      // reference to the disposed renderer — after the viewer unmounts.
      playback.getState()._stopInterval();
    },
  };
}

/**
 * The module-global singletons, presented as a bundle.
 *
 * This is what `useMeganeStores()` resolves to when no provider is mounted, so
 * every existing host and embedder keeps the exact behaviour it has today.
 */
export const globalMeganeStores: MeganeStores = {
  id: "global",
  isGlobal: true,
  pipeline: usePipelineStore,
  playback: usePlaybackStore,
  measurement: useMeasurementStore,
  viewState: useViewStateStore,
  pipelineUI: usePipelineUIStore,
  inspector: useInspectorInteractionStore,
  loadHandlers: globalLoadHandlers,
  destroy() {
    /* the process-global bundle outlives every viewer */
  },
};
