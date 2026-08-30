/**
 * Test-only registry for the Zustand stores Playwright drives.
 *
 * Historically `src/pipeline/store.ts` and `src/stores/usePlaybackStore.ts`
 * each bound their module-global singleton onto `window` at import time. That
 * works for a host that renders the singleton, but it silently misleads any
 * host that renders a *scoped* store instead: the window hook keeps pointing
 * at a store nothing is subscribed to, so every helper in
 * `tests/e2e/lib/pipeline.ts` mutates a dead object and succeeds without
 * throwing. Failures then surface only as pixel diffs and timeouts. That is
 * already the situation on the widget hosts, where `WidgetViewer` builds its
 * own store via `createPipelineStore()`.
 *
 * So registration moves here, and a bundle registers itself when it mounts:
 *
 * - `window.__megane_test_pipeline_store` / `__megane_test_playback_store`
 *   keep their existing single-store shape, so the ~88 existing references
 *   across `tests/e2e/` need no changes. They resolve to the first *scoped*
 *   bundle that registered, falling back to the module-global singleton when
 *   no provider is mounted (the standalone webapp and the VSCode webview).
 * - `window.__megane_test_store_bundles` maps every live bundle id to its
 *   stores, so a multi-viewer spec can address one viewer specifically.
 *
 * Everything here is inert outside test mode.
 */

export interface TestStoreBundle {
  pipeline?: unknown;
  playback?: unknown;
}

interface TestWindow {
  __MEGANE_TEST__?: boolean;
  __megane_test_pipeline_store?: unknown;
  __megane_test_playback_store?: unknown;
  __megane_test_store_bundles?: Record<string, TestStoreBundle>;
}

/**
 * Detect Playwright's test mode the same way `MoleculeRenderer` does:
 * an explicit global, `?test=1`, or the flag on a parent frame (the widget and
 * VSCode webview hosts run the viewer inside an iframe).
 */
export function detectTestMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const g = globalThis as TestWindow;
    if (g.__MEGANE_TEST__ === true) return true;
    const params = new URLSearchParams(window.location?.search ?? "");
    if (params.get("test") === "1") return true;
    if (window.parent && window.parent !== window) {
      if ((window.parent as Window & TestWindow).__MEGANE_TEST__) return true;
    }
    return false;
  } catch {
    // Same-origin checks throw inside cross-origin frames.
    return false;
  }
}

/** The module-global singletons, registered under this reserved id. */
export const GLOBAL_BUNDLE_ID = "global";

/**
 * Registration order of scoped bundles. The primary window hooks resolve to
 * the head of this list, so they stay pinned to one viewer as further viewers
 * mount and unmount rather than flipping to whichever mounted last.
 */
const scopedOrder: string[] = [];
const bundles = new Map<string, TestStoreBundle>();

function testWindow(): TestWindow | null {
  if (typeof window === "undefined") return null;
  return window as unknown as TestWindow;
}

/**
 * Resolve one store for the legacy hooks: the primary scoped bundle's, or the
 * module-global one when the primary does not carry that key.
 *
 * Resolved per key rather than per bundle on purpose. A bundle that registered
 * only `pipeline` would otherwise leave `__megane_test_playback_store` pointing
 * at whatever was there before — exactly the dead-store hazard this registry
 * exists to close.
 */
function resolveStore(key: keyof TestStoreBundle): unknown {
  const primaryId = scopedOrder[0];
  if (primaryId !== undefined) {
    const scoped = bundles.get(primaryId);
    if (scoped?.[key]) return scoped[key];
  }
  return bundles.get(GLOBAL_BUNDLE_ID)?.[key];
}

/** Re-point the legacy single-store hooks at the current primary bundle. */
function syncPrimary(): void {
  const w = testWindow();
  if (!w) return;
  // Assigned unconditionally: leaving a stale pointer in place is the failure
  // mode, not a missing one.
  w.__megane_test_pipeline_store = resolveStore("pipeline");
  w.__megane_test_playback_store = resolveStore("playback");
}

/**
 * Publish one bundle's stores. Returns an unregister function; calling it
 * removes the bundle and promotes the next scoped one to primary.
 *
 * No-op (returns a no-op) outside test mode.
 */
export function registerTestStores(id: string, stores: TestStoreBundle): () => void {
  if (!detectTestMode()) return () => {};
  const w = testWindow();
  if (!w) return () => {};

  const existing = bundles.get(id);
  bundles.set(id, { ...existing, ...stores });
  if (id !== GLOBAL_BUNDLE_ID && !scopedOrder.includes(id)) scopedOrder.push(id);

  if (!w.__megane_test_store_bundles) w.__megane_test_store_bundles = {};
  w.__megane_test_store_bundles[id] = bundles.get(id)!;
  syncPrimary();

  return () => {
    bundles.delete(id);
    const at = scopedOrder.indexOf(id);
    if (at !== -1) scopedOrder.splice(at, 1);
    if (w.__megane_test_store_bundles) delete w.__megane_test_store_bundles[id];
    syncPrimary();
  };
}

/** Test-only reset so unit specs do not leak registrations across files. */
export function _resetTestRegistry(): void {
  scopedOrder.length = 0;
  bundles.clear();
  const w = testWindow();
  if (!w) return;
  delete w.__megane_test_pipeline_store;
  delete w.__megane_test_playback_store;
  delete w.__megane_test_store_bundles;
}
