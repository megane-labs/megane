/**
 * Store scoping for megane Builder: one document per mounted Builder.
 *
 * A Builder's document state is three stores: the document itself
 * (`store.ts`), the library's dialogs (`library/uiStore.ts`) and the Python
 * tools, which write into that document (`tools/store.ts`). Mount a Builder
 * inside a `BuilderProvider` with a bundle from `createBuilderStores()` and it
 * edits a document of its own, so one page can hold several. The JupyterLab
 * extension opens a tab per Builder this way.
 *
 * With no provider mounted, every hook here resolves to the module-global
 * stores. `builder.html`, the VS Code webview (a page per tab) and the
 * anywidget bundle (loaded once per `Builder` object) mount it that way. The
 * molecule library (`library/store.ts`) stays page-wide: it belongs to the
 * user, not to a document.
 *
 * Same shape as the viewer's `MeganeProvider` (`src/stores/MeganeProvider.tsx`).
 */

import { createContext, useContext, useLayoutEffect } from "react";
import { useStore, type StoreApi } from "zustand";
import { registerTestStores, GLOBAL_BUNDLE_ID } from "../stores/testRegistry";
import { createBuilderStore, useBuilderStore, type BuilderStore } from "./store";
import { createLibraryUi, useLibraryUi, type LibraryUi } from "./library/uiStore";
import { createBuilderToolsStore, useToolsStore, type ToolsStore } from "./tools/store";

export interface BuilderStores {
  /** The id the bundle registers under for the E2E hooks. */
  id: string;
  builder: StoreApi<BuilderStore>;
  libraryUi: StoreApi<LibraryUi>;
  tools: StoreApi<ToolsStore>;
}

let nextBundle = 1;

/** A bundle of its own: an empty document, its library dialogs, its tools. */
export function createBuilderStores(): BuilderStores {
  const builder = createBuilderStore();
  return {
    id: `builder-${nextBundle++}`,
    builder,
    libraryUi: createLibraryUi(),
    tools: createBuilderToolsStore(builder),
  };
}

/** The module-global stores, which the hooks resolve to with no provider mounted. */
export const globalBuilderStores: BuilderStores = {
  id: GLOBAL_BUNDLE_ID,
  builder: useBuilderStore,
  libraryUi: useLibraryUi,
  tools: useToolsStore,
};

const BuilderStoresContext = createContext<BuilderStores | null>(null);

export interface BuilderProviderProps {
  stores: BuilderStores;
  children: React.ReactNode;
}

export function BuilderProvider({ stores, children }: BuilderProviderProps) {
  // Publish to the E2E registry at mount, as MeganeProvider does, so
  // `window.__megane_test_builder_store` drives a store something renders.
  useLayoutEffect(() => registerTestStores(stores.id, { builder: stores.builder }), [stores]);
  return <BuilderStoresContext.Provider value={stores}>{children}</BuilderStoresContext.Provider>;
}

/** The bundle for this subtree, or the module-global stores when no provider is mounted. */
export function useBuilderStores(): BuilderStores {
  return useContext(BuilderStoresContext) ?? globalBuilderStores;
}

// ── Per-store API accessors ────────────────────────────────────────────
// For `getState()` / `subscribe()` outside the render path (effects, event
// handlers, callbacks): read the API through the hook and close over it, so
// the callback stays bound to this Builder's document.

export function useBuilderStoreApi(): StoreApi<BuilderStore> {
  return useBuilderStores().builder;
}
export function useLibraryUiApi(): StoreApi<LibraryUi> {
  return useBuilderStores().libraryUi;
}
export function useToolsStoreApi(): StoreApi<ToolsStore> {
  return useBuilderStores().tools;
}

// ── Scoped selector hooks ──────────────────────────────────────────────
// The module-global hooks' call shapes, resolved through the context.

const identity = <S,>(state: S): S => state;

export function useScopedBuilderStore(): BuilderStore;
export function useScopedBuilderStore<T>(selector: (state: BuilderStore) => T): T;
export function useScopedBuilderStore<T>(selector?: (state: BuilderStore) => T) {
  return useStore(useBuilderStoreApi(), selector ?? (identity as (state: BuilderStore) => T));
}

export function useScopedLibraryUi(): LibraryUi;
export function useScopedLibraryUi<T>(selector: (state: LibraryUi) => T): T;
export function useScopedLibraryUi<T>(selector?: (state: LibraryUi) => T) {
  return useStore(useLibraryUiApi(), selector ?? (identity as (state: LibraryUi) => T));
}

export function useScopedToolsStore(): ToolsStore;
export function useScopedToolsStore<T>(selector: (state: ToolsStore) => T): T;
export function useScopedToolsStore<T>(selector?: (state: ToolsStore) => T) {
  return useStore(useToolsStoreApi(), selector ?? (identity as (state: ToolsStore) => T));
}
