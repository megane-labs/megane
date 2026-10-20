/**
 * The standalone Builder's autosave and leave-page warning: typed arrays
 * survive the JSON round trip, the autosave follows the document (written
 * while unsaved, removed once saved), a restore keeps Undo steps, and no
 * storage failure ever throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  AUTOSAVE_DELAY_MS,
  AUTOSAVE_KEY,
  AUTOSAVE_MAX_CHARS,
  autosaveText,
  autosaveTime,
  clearAutosave,
  decodeValue,
  encodeValue,
  readAutosave,
  restoreAutosave,
  useAutosave,
  useUnsavedGuard,
  writeAutosave,
} from "@/builder/autosave";
import { createBuilderStore, editSteps } from "@/builder/store";
import { describeStep } from "@/builder/placement";
import type { EditOp } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const move = (atom: number, dx: number): EditOp => ({
  op: "move_atoms",
  atoms: [atom],
  delta: [dx, 0, 0],
});

/** A store with water open and two Undo steps: a labelled pair of moves, then one move. */
function editedStore() {
  const api = createBuilderStore();
  api.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "water.pdb");
  api.getState().pushOps([move(1, 1), move(2, 1)], "Nudge the hydrogens");
  api.getState().pushOp(move(0, 2));
  return api;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("encodeValue / decodeValue", () => {
  it("round-trips typed arrays anywhere in a value, and leaves the rest alone", () => {
    const value = {
      a: new Float32Array([1.5, 2]),
      nested: [{ b: new Uint32Array([7]) }, "x", null, 3],
      skipped: undefined,
    };
    const json = JSON.parse(JSON.stringify(encodeValue(value)));
    expect(json.a).toEqual({ $typed: "Float32Array", data: [1.5, 2] });
    expect("skipped" in json).toBe(false);
    const back = decodeValue(json) as typeof value;
    expect(back.a).toBeInstanceOf(Float32Array);
    expect(Array.from(back.a)).toEqual([1.5, 2]);
    expect(back.nested[0]).toEqual({ b: new Uint32Array([7]) });
    expect(back.nested.slice(1)).toEqual(["x", null, 3]);
    // A DataView is not a typed array: it passes through as an object.
    expect(encodeValue(new DataView(new ArrayBuffer(1)))).toEqual({});
    // A tag naming no typed array stays a plain object.
    expect(decodeValue({ $typed: "Nope", data: [1] })).toEqual({ $typed: "Nope", data: [1] });
  });
});

describe("autosaveText / writeAutosave / readAutosave", () => {
  it("keeps the document only while it has unsaved edits", () => {
    const api = createBuilderStore();
    expect(autosaveText(api.getState())).toBeNull();
    api.getState().openStructure(water(), null, "water.pdb");
    expect(autosaveText(api.getState())).toBeNull();
    api.getState().pushOp(move(0, 1));
    const text = autosaveText(api.getState(), 1234)!;
    const json = JSON.parse(text);
    expect(json).toMatchObject({ version: 1, savedAt: 1234, fileName: "water.pdb" });
    expect(json.steps).toEqual([[move(0, 1)]]);
    expect(json.labels).toEqual([null]);
  });

  it("writes, reads back with typed arrays and labels, and removes once saved", () => {
    const api = editedStore();
    writeAutosave(api.getState(), 99);
    const data = readAutosave()!;
    expect(data.fileName).toBe("water.pdb");
    expect(data.savedAt).toBe(99);
    expect(data.source.positions).toBeInstanceOf(Float32Array);
    expect(data.source.box).toBeInstanceOf(Float32Array);
    expect(data.sourceLabels).toEqual(["HOH", "HOH", "HOH"]);
    expect(data.steps).toEqual([[move(1, 1), move(2, 1)], [move(0, 2)]]);
    expect(data.labels).toEqual(["Nudge the hydrogens", null]);
    api.getState().markSaved();
    writeAutosave(api.getState());
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
    expect(readAutosave()).toBeNull();
  });

  it("skips a document too large to keep, removing an older autosave", () => {
    const api = editedStore();
    writeAutosave(api.getState());
    expect(localStorage.getItem(AUTOSAVE_KEY)).not.toBeNull();
    api.setState({ sourceLabels: ["x".repeat(AUTOSAVE_MAX_CHARS)] });
    expect(autosaveText(api.getState())).toBeNull();
    writeAutosave(api.getState());
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
  });

  it("an unserialisable document is not kept", () => {
    const api = editedStore();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    api.setState({ sourceLabels: [loop as unknown as string] });
    expect(autosaveText(api.getState())).toBeNull();
  });

  it("ignores what is not an autosave", () => {
    expect(readAutosave()).toBeNull();
    localStorage.setItem(AUTOSAVE_KEY, "{not json");
    expect(readAutosave()).toBeNull();
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ version: 2, steps: [], source: {} }));
    expect(readAutosave()).toBeNull();
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify({ version: 1, steps: [], source: { nAtoms: 1, positions: [0, 0, 0] } }),
    );
    expect(readAutosave()).toBeNull();
    // Missing fields fall back; empty and malformed steps are dropped.
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify({
        version: 1,
        source: encodeValue(water()),
        steps: [[], "x", [move(0, 1)]],
        labels: "nope",
      }),
    );
    expect(readAutosave()).toMatchObject({
      savedAt: 0,
      fileName: null,
      sourceLabels: null,
      steps: [[move(0, 1)]],
      labels: [null],
    });
  });

  it("never throws when storage does", () => {
    const api = editedStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeAutosave(api.getState())).not.toThrow();
    expect(readAutosave()).toBeNull();
    expect(() => clearAutosave()).not.toThrow();
  });

  it("does nothing where there is no localStorage", () => {
    const api = editedStore();
    vi.stubGlobal("localStorage", undefined);
    try {
      expect(() => writeAutosave(api.getState())).not.toThrow();
      expect(readAutosave()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clearAutosave removes it", () => {
    writeAutosave(editedStore().getState());
    clearAutosave();
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
  });
});

describe("restoreAutosave", () => {
  it("re-opens the source and replays each step as one Undo step, labels kept", () => {
    writeAutosave(editedStore().getState());
    const api = createBuilderStore();
    expect(restoreAutosave(api, readAutosave()!)).toBe(true);
    const s = api.getState();
    expect(s.fileName).toBe("water.pdb");
    expect(s.sourceLabels).toEqual(["HOH", "HOH", "HOH"]);
    expect(editSteps(s.edits)).toHaveLength(2);
    expect(describeStep(editSteps(s.edits)[0])).toBe("Nudge the hydrogens");
    expect(s.notice).toEqual({ level: "info", text: "Restored water.pdb with 2 unsaved edits." });
    // Still unsaved, and one Undo takes back exactly one step.
    expect(s.docVersion).not.toBe(s.savedVersion);
    api.getState().undo();
    expect(api.getState().edits).toHaveLength(2);
  });

  it("names an untitled document and says why a restore failed", () => {
    const api = createBuilderStore();
    const data = {
      version: 1 as const,
      savedAt: 0,
      fileName: null,
      source: water(),
      sourceLabels: null,
      steps: [[move(0, 1)]],
      labels: [null],
    };
    expect(restoreAutosave(api, data)).toBe(true);
    expect(api.getState().fileName).toBe("untitled");
    expect(api.getState().notice?.text).toBe("Restored the structure with 1 unsaved edit.");

    api.setState({
      pushOps: () => {
        throw new Error("bad op");
      },
    });
    expect(restoreAutosave(api, data)).toBe(false);
    expect(api.getState().notice).toEqual({
      level: "error",
      text: "Could not restore the structure: bad op",
    });
    api.setState({
      pushOps: () => {
        throw "plain";
      },
    });
    expect(restoreAutosave(api, { ...data, fileName: "x.xyz" })).toBe(false);
    expect(api.getState().notice?.text).toBe("Could not restore x.xyz: plain");
  });
});

describe("autosaveTime", () => {
  it("says today for the same day, else the date", () => {
    const now = new Date(2026, 9, 19, 15, 0).getTime();
    expect(autosaveTime(new Date(2026, 9, 19, 14, 5).getTime(), now)).toMatch(/^today at /);
    const earlier = autosaveTime(new Date(2026, 9, 1, 9, 0).getTime(), now);
    expect(earlier).not.toMatch(/^today/);
    expect(earlier).toContain(" at ");
    expect(autosaveTime(Date.now())).toMatch(/^today at /);
  });
});

describe("useAutosave", () => {
  it("writes a moment after a change, at once when the page hides, and on unmount", () => {
    vi.useFakeTimers();
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "water.pdb");
    const { unmount } = renderHook(() => useAutosave(api, true));
    api.getState().pushOp(move(0, 1));
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
    // A change that is not the document's (the tool) does not reschedule.
    api.getState().setTool("add");
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(readAutosave()?.steps).toHaveLength(1);

    // Saved: the autosave goes.
    api.getState().markSaved();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(readAutosave()).toBeNull();

    // A hidden page writes at once; a visible one waits.
    api.getState().pushOp(move(0, 1));
    api.getState().pushOp(move(0, 1));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(readAutosave()).toBeNull();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(readAutosave()?.steps).toHaveLength(3);
    // Nothing pending: a pagehide does not write.
    localStorage.clear();
    window.dispatchEvent(new Event("pagehide"));
    expect(readAutosave()).toBeNull();

    api.getState().pushOp(move(0, 1));
    window.dispatchEvent(new Event("pagehide"));
    expect(readAutosave()?.steps).toHaveLength(4);

    api.getState().pushOp(move(0, 1));
    unmount();
    expect(readAutosave()?.steps).toHaveLength(5);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("does nothing when disabled", () => {
    vi.useFakeTimers();
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "water.pdb");
    const { unmount } = renderHook(() => useAutosave(api, false));
    api.getState().pushOp(move(0, 1));
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    unmount();
    expect(readAutosave()).toBeNull();
  });
});

describe("useUnsavedGuard", () => {
  const leave = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e;
  };

  it("asks before leaving with unsaved edits, and keeps the autosave current", () => {
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "water.pdb");
    const { unmount } = renderHook(() => useUnsavedGuard(api, true));
    expect(leave().defaultPrevented).toBe(false);
    api.getState().pushOp(move(0, 1));
    expect(leave().defaultPrevented).toBe(true);
    expect(readAutosave()?.steps).toHaveLength(1);
    unmount();
    expect(leave().defaultPrevented).toBe(false);
  });

  it("never asks when disabled (an embedding host)", () => {
    const api = editedStore();
    const { unmount } = renderHook(() => useUnsavedGuard(api, false));
    expect(leave().defaultPrevented).toBe(false);
    unmount();
  });
});
