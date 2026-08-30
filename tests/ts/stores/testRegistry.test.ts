import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerTestStores,
  detectTestMode,
  _resetTestRegistry,
  GLOBAL_BUNDLE_ID,
} from "@/stores/testRegistry";

interface TestWindow {
  __MEGANE_TEST__?: boolean;
  __megane_test_pipeline_store?: unknown;
  __megane_test_playback_store?: unknown;
  __megane_test_store_bundles?: Record<string, { pipeline?: unknown; playback?: unknown }>;
}

const w = window as unknown as TestWindow;

function enableTestMode() {
  (globalThis as TestWindow).__MEGANE_TEST__ = true;
}

describe("testRegistry", () => {
  beforeEach(() => {
    _resetTestRegistry();
    delete (globalThis as TestWindow).__MEGANE_TEST__;
  });
  afterEach(() => {
    _resetTestRegistry();
    delete (globalThis as TestWindow).__MEGANE_TEST__;
  });

  describe("detectTestMode", () => {
    it("is off by default", () => {
      expect(detectTestMode()).toBe(false);
    });

    it("honours the __MEGANE_TEST__ global", () => {
      enableTestMode();
      expect(detectTestMode()).toBe(true);
    });

    it("honours ?test=1", () => {
      const spy = vi.spyOn(window, "location", "get");
      spy.mockReturnValue({ search: "?test=1" } as Location);
      expect(detectTestMode()).toBe(true);
      spy.mockRestore();
    });
  });

  describe("registerTestStores", () => {
    it("publishes nothing outside test mode", () => {
      const unregister = registerTestStores("a", { pipeline: { tag: "a" } });
      expect(w.__megane_test_pipeline_store).toBeUndefined();
      expect(w.__megane_test_store_bundles).toBeUndefined();
      unregister();
    });

    it("binds the legacy hook to the global bundle when nothing else registers", () => {
      enableTestMode();
      const global = { tag: "global" };
      registerTestStores(GLOBAL_BUNDLE_ID, { pipeline: global });

      expect(w.__megane_test_pipeline_store).toBe(global);
    });

    it("hands the legacy hook to a scoped bundle, so specs drive a rendered store", () => {
      enableTestMode();
      const global = { tag: "global" };
      const scoped = { tag: "scoped" };
      registerTestStores(GLOBAL_BUNDLE_ID, { pipeline: global });
      registerTestStores("viewer-1", { pipeline: scoped });

      // Without this, the hook keeps pointing at a store nothing renders and
      // every Playwright helper mutates a dead object without throwing.
      expect(w.__megane_test_pipeline_store).toBe(scoped);
    });

    it("keeps the hook pinned to the first viewer as later ones mount", () => {
      enableTestMode();
      const first = { tag: "first" };
      const second = { tag: "second" };
      registerTestStores("viewer-1", { pipeline: first });
      registerTestStores("viewer-2", { pipeline: second });

      expect(w.__megane_test_pipeline_store).toBe(first);
    });

    it("promotes the next viewer when the primary unmounts", () => {
      enableTestMode();
      const first = { tag: "first" };
      const second = { tag: "second" };
      const unregisterFirst = registerTestStores("viewer-1", { pipeline: first });
      registerTestStores("viewer-2", { pipeline: second });

      unregisterFirst();

      expect(w.__megane_test_pipeline_store).toBe(second);
    });

    it("falls back to the global bundle once every viewer unmounts", () => {
      enableTestMode();
      const global = { tag: "global" };
      const scoped = { tag: "scoped" };
      registerTestStores(GLOBAL_BUNDLE_ID, { pipeline: global });
      const unregister = registerTestStores("viewer-1", { pipeline: scoped });

      unregister();

      expect(w.__megane_test_pipeline_store).toBe(global);
    });

    it("exposes every live bundle by id so a spec can address one viewer", () => {
      enableTestMode();
      const left = { tag: "left" };
      const right = { tag: "right" };
      registerTestStores("left", { pipeline: left });
      registerTestStores("right", { pipeline: right });

      expect(w.__megane_test_store_bundles?.left?.pipeline).toBe(left);
      expect(w.__megane_test_store_bundles?.right?.pipeline).toBe(right);
    });

    it("drops a bundle from the map on unregister", () => {
      enableTestMode();
      const unregister = registerTestStores("left", { pipeline: {} });
      expect(w.__megane_test_store_bundles?.left).toBeDefined();

      unregister();

      expect(w.__megane_test_store_bundles?.left).toBeUndefined();
    });

    it("merges the pipeline and playback stores registered separately", () => {
      enableTestMode();
      const pipeline = { tag: "pipeline" };
      const playback = { tag: "playback" };
      registerTestStores(GLOBAL_BUNDLE_ID, { pipeline });
      registerTestStores(GLOBAL_BUNDLE_ID, { playback });

      expect(w.__megane_test_pipeline_store).toBe(pipeline);
      expect(w.__megane_test_playback_store).toBe(playback);
    });
  });
});
