/** Flow mode kept across reloads: the graph, its name and the mode, in localStorage. */

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  FLOW_STORAGE_KEY,
  defaultFlowStorage,
  persistedText,
  readPersistedFlow,
  useFlowPersistence,
  writePersistedFlow,
} from "@/builder/flow/persist";
import { createFlowStore } from "@/builder/flow/store";
import { flowFileName, FLOW_FILE_NAME } from "@/builder/flow/useFlowMode";
import type { FlowParams } from "@/builder/flow/types";

const mol: FlowParams = {
  type: "molecule",
  source: "smiles",
  smiles: "O",
  libraryId: "",
  name: "",
};

/** A Storage whose every access throws, as a blocked one does. */
const blocked = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
} as unknown as Storage;

beforeEach(() => localStorage.clear());

describe("readPersistedFlow / writePersistedFlow", () => {
  it("round-trips the graph, the name and the mode", () => {
    const s = createFlowStore();
    s.getState().addNode(mol);
    s.getState().load(s.getState().serialize(), { name: "mix.megane-flow.json" });
    s.getState().setMode("flow");
    writePersistedFlow(localStorage, persistedText(s.getState()));
    expect(readPersistedFlow(localStorage)).toEqual({
      mode: "flow",
      flow: s.getState().serialize(),
      name: "mix.megane-flow.json",
    });
  });

  it("ignores what is not a kept flow, and storage it cannot reach", () => {
    expect(readPersistedFlow(null)).toBeNull();
    expect(readPersistedFlow(localStorage)).toBeNull();
    localStorage.setItem(FLOW_STORAGE_KEY, "{not json");
    expect(readPersistedFlow(localStorage)).toBeNull();
    localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify({ mode: "other", flow: {} }));
    expect(readPersistedFlow(localStorage)).toBeNull();
    localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify({ mode: "flow", flow: { version: 2 } }));
    expect(readPersistedFlow(localStorage)).toBeNull();
    localStorage.setItem(
      FLOW_STORAGE_KEY,
      JSON.stringify({ mode: "manual", flow: { version: 1, nodes: [], edges: [] }, name: 3 }),
    );
    expect(readPersistedFlow(localStorage)?.name).toBeNull();
    expect(readPersistedFlow(blocked)).toBeNull();
    expect(() => writePersistedFlow(blocked, "x")).not.toThrow();
    expect(() => writePersistedFlow(null, "x")).not.toThrow();
    expect(defaultFlowStorage()).toBe(localStorage);
  });
});

describe("useFlowPersistence", () => {
  it("restores the kept flow and mode into an empty store, then keeps them up to date", () => {
    const first = createFlowStore();
    first.getState().addNode(mol);
    first.getState().setMode("flow");
    writePersistedFlow(localStorage, persistedText(first.getState()));

    const s = createFlowStore();
    const { unmount } = renderHook(() => useFlowPersistence(s, localStorage));
    expect(s.getState().nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(s.getState().mode).toBe("flow");
    // Restoring is not something to undo.
    expect(s.getState().past).toEqual([]);

    act(() => {
      s.getState().addNode(mol);
      s.getState().setMode("manual");
    });
    const kept = readPersistedFlow(localStorage)!;
    expect(kept.flow.nodes).toHaveLength(2);
    expect(kept.mode).toBe("manual");
    // Selecting a block changes nothing that is kept.
    const text = localStorage.getItem(FLOW_STORAGE_KEY);
    act(() => s.getState().selectNode("n1"));
    expect(localStorage.getItem(FLOW_STORAGE_KEY)).toBe(text);
    unmount();
  });

  it("leaves a store that already has blocks alone, and works without storage", () => {
    writePersistedFlow(
      localStorage,
      JSON.stringify({ mode: "flow", flow: { version: 1, nodes: [], edges: [] }, name: null }),
    );
    const s = createFlowStore();
    s.getState().addNode(mol);
    s.getState().addNode(mol);
    renderHook(() => useFlowPersistence(s, localStorage));
    expect(s.getState().nodes).toHaveLength(2);
    expect(s.getState().mode).toBe("manual");

    const t = createFlowStore();
    renderHook(() => useFlowPersistence(t, blocked));
    act(() => {
      t.getState().addNode(mol);
    });
    expect(t.getState().nodes).toHaveLength(1);
  });
});

describe("flowFileName", () => {
  it("derives Save's name from the file or template the flow came from", () => {
    expect(flowFileName(null)).toBe(FLOW_FILE_NAME);
    expect(flowFileName("mix.megane-flow.json")).toBe("mix.megane-flow.json");
    expect(flowFileName("my flow.json")).toBe("my_flow.megane-flow.json");
    expect(flowFileName("slab-adsorbates")).toBe("slab-adsorbates.megane-flow.json");
    expect(flowFileName("../../etc/passwd")).toBe("etc_passwd.megane-flow.json");
    expect(flowFileName("///.json")).toBe(FLOW_FILE_NAME);
  });
});
