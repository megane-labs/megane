/**
 * Builder store scoping: inside a `BuilderProvider` the hooks read that
 * Builder's own bundle; without one they read the page-wide stores, so
 * `builder.html`, the VS Code webview and the Jupyter widget are unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import {
  BuilderProvider,
  createBuilderStores,
  globalBuilderStores,
  useBuilderStoreApi,
  useLibraryUiApi,
  useToolsStoreApi,
  useScopedBuilderStore,
  useScopedLibraryUi,
  useScopedToolsStore,
  type BuilderStores,
} from "@/builder/BuilderStores";
import { emptyCellSnapshot, useBuilderStore } from "@/builder/store";
import { useLibraryUi } from "@/builder/library/ui";
import { useToolsStore } from "@/builder/tools/store";
import { GLOBAL_BUNDLE_ID, _resetTestRegistry } from "@/stores/testRegistry";

type TestWindow = {
  __MEGANE_TEST__?: boolean;
  __megane_test_builder_store?: unknown;
  __megane_test_store_bundles?: Record<string, { builder?: unknown }>;
};

const seen: Record<string, unknown[]> = {};

function Probe({ id }: { id: string }) {
  const fileName = useScopedBuilderStore((s) => s.fileName);
  const tool = useScopedBuilderStore().tool;
  const sketch = useScopedLibraryUi((s) => s.sketch);
  const galleryOpen = useScopedLibraryUi().galleryOpen;
  const status = useScopedToolsStore((s) => s.status);
  const url = useScopedToolsStore().url;
  seen[id] = [useBuilderStoreApi(), useLibraryUiApi(), useToolsStoreApi()];
  return (
    <span data-testid={id}>
      {[fileName, tool, sketch ? "sketch" : "-", galleryOpen, status, url ? "url" : "-"].join("|")}
    </span>
  );
}

afterEach(() => {
  cleanup();
  delete (globalThis as TestWindow).__MEGANE_TEST__;
  _resetTestRegistry();
});

describe("createBuilderStores", () => {
  it("gives each bundle its own document, library dialogs and tools", () => {
    const a = createBuilderStores();
    const b = createBuilderStores();
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(GLOBAL_BUNDLE_ID);
    for (const key of ["builder", "libraryUi", "tools"] as const) {
      expect(a[key]).not.toBe(b[key]);
      expect(a[key]).not.toBe(globalBuilderStores[key]);
    }
    a.builder.getState().openStructure(emptyCellSnapshot(10), null, "cell.xyz");
    expect(b.builder.getState().fileName).toBeNull();
    expect(a.tools.getState().status).toBe("idle");
  });

  it("the global bundle is the page-wide stores", () => {
    expect(globalBuilderStores).toMatchObject({
      id: GLOBAL_BUNDLE_ID,
      builder: useBuilderStore,
      libraryUi: useLibraryUi,
      tools: useToolsStore,
    });
  });
});

describe("BuilderProvider", () => {
  it("scopes its subtree to its bundle; outside it the hooks read the page-wide stores", () => {
    const stores = createBuilderStores();
    render(
      <>
        <Probe id="page" />
        <BuilderProvider stores={stores}>
          <Probe id="scoped" />
        </BuilderProvider>
      </>,
    );
    expect(seen.page).toEqual([useBuilderStore, useLibraryUi, useToolsStore]);
    expect(seen.scoped).toEqual([stores.builder, stores.libraryUi, stores.tools]);

    act(() => {
      stores.builder.getState().openStructure(emptyCellSnapshot(10), null, "cell.xyz");
      stores.libraryUi.getState().openSketch();
      stores.libraryUi.getState().setGalleryOpen(true);
    });
    expect(screen.getByTestId("scoped").textContent).toMatch(/^cell\.xyz\|select\|sketch\|true\|/);
    expect(screen.getByTestId("page").textContent).toMatch(/^\|select\|-\|false\|/);
    expect(useBuilderStore.getState().fileName).toBeNull();
    expect(useLibraryUi.getState().sketch).toBeNull();
  });

  it("registers its document for the E2E hooks while mounted", () => {
    (globalThis as TestWindow).__MEGANE_TEST__ = true;
    const w = window as unknown as TestWindow;
    const stores: BuilderStores = createBuilderStores();
    const { unmount } = render(
      <BuilderProvider stores={stores}>
        <Probe id="scoped" />
      </BuilderProvider>,
    );
    expect(w.__megane_test_builder_store).toBe(stores.builder);
    expect(w.__megane_test_store_bundles?.[stores.id]?.builder).toBe(stores.builder);
    unmount();
    expect(w.__megane_test_store_bundles?.[stores.id]).toBeUndefined();
  });
});
