import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";

const STORAGE_KEY = "megane-pipeline-ui";

function resetStore() {
  usePipelineUIStore.setState({ mode: "chat", pendingNotice: null });
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

  it("defaults to the chat tab and no pending notice", () => {
    expect(usePipelineUIStore.getState().mode).toBe("chat");
    expect(usePipelineUIStore.getState().pendingNotice).toBeNull();
  });

  it("setMode persists the chosen tab to sessionStorage (not localStorage)", () => {
    usePipelineUIStore.getState().setMode("chat");

    expect(usePipelineUIStore.getState().mode).toBe("chat");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual({ mode: "chat" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    usePipelineUIStore.getState().setMode("editor");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual({ mode: "editor" });
  });

  it("setMode tolerates a sessionStorage that throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => usePipelineUIStore.getState().setMode("chat")).not.toThrow();
    expect(usePipelineUIStore.getState().mode).toBe("chat");
    setItem.mockRestore();
  });

  it("markPipelineApplied stamps a notice without leaving the current tab", () => {
    usePipelineUIStore.setState({ mode: "chat", pendingNotice: null });

    usePipelineUIStore.getState().markPipelineApplied();

    expect(usePipelineUIStore.getState().mode).toBe("chat");
    expect(usePipelineUIStore.getState().pendingNotice).toMatchObject({ kind: "applied" });
  });

  it("each markPipelineApplied call yields a fresh notice id", () => {
    usePipelineUIStore.getState().markPipelineApplied();
    const first = usePipelineUIStore.getState().pendingNotice!.id;

    usePipelineUIStore.getState().markPipelineApplied();
    const second = usePipelineUIStore.getState().pendingNotice!.id;

    expect(second).toBeGreaterThan(first);
  });

  it("dismissNotice clears the pending notice", () => {
    usePipelineUIStore.getState().markPipelineApplied();
    expect(usePipelineUIStore.getState().pendingNotice).not.toBeNull();

    usePipelineUIStore.getState().dismissNotice();
    expect(usePipelineUIStore.getState().pendingNotice).toBeNull();
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

  it("keeps the Build panel closed by default and never persists it", () => {
    expect(usePipelineUIStore.getState().buildOpen).toBe(false);
    usePipelineUIStore.getState().setBuildOpen(true);
    expect(usePipelineUIStore.getState().buildOpen).toBe(true);
    usePipelineUIStore.getState().setMode("editor");
    // Only the tab is written: an open Build panel puts the 3D view in edit
    // mode, so a fresh session must not start there.
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual({ mode: "editor" });
    usePipelineUIStore.getState().setBuildOpen(false);
    expect(usePipelineUIStore.getState().buildOpen).toBe(false);
  });

  it("treats a stale 'build' tab from an earlier build as unset", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "build" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("chat");
  });

  it("hydrates the mode from sessionStorage when a valid value is stored", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "editor" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("ignores legacy localStorage entries and defaults to 'chat' on cold start", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "editor" }));
    const mod = await import("@/stores/usePipelineUIStore");
    // Cold-start always opens on the chat tab — the assistant is the primary
    // entry point. The legacy localStorage entry is also cleaned up.
    expect(mod.usePipelineUIStore.getState().mode).toBe("chat");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("falls back to 'chat' when the stored payload is malformed", async () => {
    sessionStorage.setItem(STORAGE_KEY, "not-json");
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("chat");
  });

  it("falls back to 'chat' when the stored mode is unknown", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "neon" }));
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("chat");
  });

  it("falls back to 'chat' when sessionStorage.getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mod = await import("@/stores/usePipelineUIStore");
    expect(mod.usePipelineUIStore.getState().mode).toBe("chat");
  });
});
