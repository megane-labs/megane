/**
 * Store scoping for `MeganeViewer` — the fix for issue #672.
 *
 * Wrap each viewer in its own provider and the viewers stop sharing state:
 *
 * ```tsx
 * <MeganeProvider>
 *   <MeganeViewer onUploadStructure={…} />
 * </MeganeProvider>
 * <MeganeProvider>
 *   <MeganeViewer onUploadStructure={…} />
 * </MeganeProvider>
 * ```
 *
 * With NO provider mounted, every hook here resolves to the module-global
 * singletons, so the standalone webapp, the VSCode webview, and every existing
 * embedder behave exactly as before. That fallback is what makes this a
 * non-breaking change — and it is also why the webapp keeps working even
 * though `src/index.tsx` drives the pipeline store from *outside* the viewer
 * (hash restore, drag-drop, template loading).
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";
import {
  createMeganeStores,
  globalMeganeStores,
  type CreateMeganeStoresOptions,
  type MeganeStores,
} from "./meganeStores";
import { registerTestStores } from "./testRegistry";
import type { PipelineStore } from "../pipeline/store";
import type { PlaybackStore } from "./usePlaybackStore";
import type { MeasurementStore } from "./useMeasurementStore";
import type { ViewStateStore } from "./useViewStateStore";
import type { PipelineUIStore } from "./usePipelineUIStore";
import type { InspectorInteractionStore } from "./useInspectorInteractionStore";
import type { MeganeLoadHandlers } from "./loadHandlers";

const MeganeStoresContext = createContext<MeganeStores | null>(null);

export interface MeganeProviderProps {
  /**
   * Use a bundle you built yourself with `createMeganeStores()`. Reach for
   * this when the surrounding app needs to drive the viewer imperatively —
   * calling `stores.pipeline.getState().openFile(file)` from an effect, say.
   * Omit it and the provider creates (and owns) one bundle for its lifetime.
   */
  stores?: MeganeStores;
  /** Options for the bundle the provider creates. Ignored when `stores` is passed. */
  options?: CreateMeganeStoresOptions;
  children: React.ReactNode;
}

export function MeganeProvider({ stores, options, children }: MeganeProviderProps) {
  // `useState` initialiser, not `useMemo`: the store bundle must survive every
  // re-render, and useMemo is a performance hint React may discard.
  const [ownStores] = useState(() => createMeganeStores(options));
  const active = stores ?? ownStores;

  // Only destroy a bundle this provider created. An injected one belongs to
  // the caller, who may outlive this mount or reuse it elsewhere.
  const ownsBundle = stores === undefined;
  const ownStoresRef = useRef(ownStores);
  useEffect(() => {
    if (!ownsBundle) return;
    const owned = ownStoresRef.current;
    return () => owned.destroy();
  }, [ownsBundle]);

  // Publish to the E2E registry so `window.__megane_test_pipeline_store`
  // resolves to a store something actually renders. Registering at mount
  // rather than module scope is what stops Playwright helpers from silently
  // driving an unrendered store — see ./testRegistry.ts.
  //
  // Layout effect, not a passive one: this must land before first paint, and
  // so before MoleculeRenderer flips `__megane_test_ready.firstFrame`, or a
  // waitForReady-gated helper can read the hook before the takeover.
  useLayoutEffect(
    () =>
      registerTestStores(active.id, {
        pipeline: active.pipeline,
        playback: active.playback,
      }),
    [active],
  );

  return <MeganeStoresContext.Provider value={active}>{children}</MeganeStoresContext.Provider>;
}

/**
 * The bundle for this subtree, or the module-global singletons when no
 * provider is mounted.
 */
export function useMeganeStores(): MeganeStores {
  return useContext(MeganeStoresContext) ?? globalMeganeStores;
}

// ── Per-store API accessors ────────────────────────────────────────────
// Use these wherever a component needs `getState()` / `setState()` /
// `subscribe()` outside the render path — effects, event handlers, and
// callbacks handed to non-React objects (the renderer, a FrameProvider, a
// WebSocket). Reading the API through the hook, then closing over it, keeps
// those long-lived callbacks bound to the right viewer's store.

export function usePipelineStoreApi(): StoreApi<PipelineStore> {
  return useMeganeStores().pipeline;
}
export function usePlaybackStoreApi(): StoreApi<PlaybackStore> {
  return useMeganeStores().playback;
}
export function useMeasurementStoreApi(): StoreApi<MeasurementStore> {
  return useMeganeStores().measurement;
}
export function useViewStateStoreApi(): StoreApi<ViewStateStore> {
  return useMeganeStores().viewState;
}
export function usePipelineUIStoreApi(): StoreApi<PipelineUIStore> {
  return useMeganeStores().pipelineUI;
}
export function useInspectorStoreApi(): StoreApi<InspectorInteractionStore> {
  return useMeganeStores().inspector;
}
export function useLoadHandlers(): MeganeLoadHandlers {
  return useMeganeStores().loadHandlers;
}

// ── Scoped selector hooks ──────────────────────────────────────────────
// Drop-in replacements for the module-global hooks, resolving through the
// context. Same call shapes as Zustand's own: pass a selector
// (`useScopedPipelineStore((s) => s.nodes)`) or omit it for the whole state.

const identity = <S,>(state: S): S => state;

export function useScopedPipelineStore(): PipelineStore;
export function useScopedPipelineStore<T>(selector: (state: PipelineStore) => T): T;
export function useScopedPipelineStore<T>(selector?: (state: PipelineStore) => T) {
  return useStore(usePipelineStoreApi(), selector ?? (identity as (state: PipelineStore) => T));
}

export function useScopedPlaybackStore(): PlaybackStore;
export function useScopedPlaybackStore<T>(selector: (state: PlaybackStore) => T): T;
export function useScopedPlaybackStore<T>(selector?: (state: PlaybackStore) => T) {
  return useStore(usePlaybackStoreApi(), selector ?? (identity as (state: PlaybackStore) => T));
}

export function useScopedMeasurementStore(): MeasurementStore;
export function useScopedMeasurementStore<T>(selector: (state: MeasurementStore) => T): T;
export function useScopedMeasurementStore<T>(selector?: (state: MeasurementStore) => T) {
  return useStore(
    useMeasurementStoreApi(),
    selector ?? (identity as (state: MeasurementStore) => T),
  );
}

export function useScopedViewStateStore(): ViewStateStore;
export function useScopedViewStateStore<T>(selector: (state: ViewStateStore) => T): T;
export function useScopedViewStateStore<T>(selector?: (state: ViewStateStore) => T) {
  return useStore(useViewStateStoreApi(), selector ?? (identity as (state: ViewStateStore) => T));
}

export function useScopedPipelineUIStore(): PipelineUIStore;
export function useScopedPipelineUIStore<T>(selector: (state: PipelineUIStore) => T): T;
export function useScopedPipelineUIStore<T>(selector?: (state: PipelineUIStore) => T) {
  return useStore(usePipelineUIStoreApi(), selector ?? (identity as (state: PipelineUIStore) => T));
}

export function useScopedInspectorStore(): InspectorInteractionStore;
export function useScopedInspectorStore<T>(selector: (state: InspectorInteractionStore) => T): T;
export function useScopedInspectorStore<T>(selector?: (state: InspectorInteractionStore) => T) {
  return useStore(
    useInspectorStoreApi(),
    selector ?? (identity as (state: InspectorInteractionStore) => T),
  );
}
