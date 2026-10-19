import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePipelineUIStore, createPipelineUIStore } from "@/stores/usePipelineUIStore";

const STORAGE_KEY = "megane-pipeline-ui";

function resetStore() {
  usePipelineUIStore.setState({ mode: "editor" });
}

describe("usePipelineUIStore", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the editor tab, where the assistant is docked", () => {
    expect(usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("setMode persists the chosen tab to sessionStorage (not localStorage)", () => {
    usePipelineUIStore.getState().setMode("inspector");

    expect(usePipelineUIStore.getState().mode).toBe("inspector");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual({ mode: "inspector" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    usePipelineUIStore.getState().setMode("editor");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual({ mode: "editor" });
  });

  it("setMode tolerates a sessionStorage that throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => usePipelineUIStore.getState().setMode("inspector")).not.toThrow();
    expect(usePipelineUIStore.getState().mode).toBe("inspector");
    setItem.mockRestore();
  });

  it("an in-memory store starts on the editor tab and persists nothing", () => {
    const store = createPipelineUIStore();
    expect(store.getState().mode).toBe("editor");
    store.getState().setMode("inspector");
    expect(store.getState().mode).toBe("inspector");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("usePipelineUIStore initial load", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a stale 'build' tab from an earlier build as unset", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "build" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("sends a stored 'chat' tab from an earlier build to the editor", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "chat" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("hydrates the mode from sessionStorage when a valid value is stored", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "inspector" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("inspector");
  });

  it("ignores legacy localStorage entries and defaults to 'editor' on cold start", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "inspector" }));
    const mod = await import("@/stores/usePipelineUIStore");
    // Cold-start always opens on the editor tab. The legacy localStorage entry
    // is also cleaned up.
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("falls back to 'editor' when the stored payload is malformed", async () => {
    sessionStorage.setItem(STORAGE_KEY, "not-json");
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("falls back to 'editor' when the stored mode is unknown", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "neon" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("falls back to 'editor' when sessionStorage.getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
  });
});
