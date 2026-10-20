/**
 * Opening a structure file: what the notice says about frames, warnings and
 * extra dropped files, and the question asked before unsaved edits are lost.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { parseStructureFile } = vi.hoisted(() => ({ parseStructureFile: vi.fn() }));
vi.mock("@/parsers/structure", () => ({ parseStructureFile }));

import { frameCount, openedNotice, openStructureFile, openStructureFiles } from "@/builder/open";
import { createBuilderStore } from "@/builder/store";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const parsed = (extra: Record<string, unknown> = {}) => ({
  snapshot: water(),
  labels: null,
  frames: [],
  meta: null,
  vectorChannels: [],
  scalarChannels: [],
  warnings: [],
  ...extra,
});

/** Flush the microtasks that put the confirm dialog up. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  parseStructureFile.mockReset();
});

describe("frameCount / openedNotice", () => {
  it("counts frames from the meta, else the extra frames", () => {
    expect(frameCount({})).toBe(1);
    expect(frameCount({ frames: [{} as never, {} as never] })).toBe(3);
    expect(frameCount({ meta: { nFrames: 12, timestepPs: 1, nAtoms: 3 } })).toBe(12);
    expect(frameCount({ meta: { nFrames: 0, timestepPs: 1, nAtoms: 3 } })).toBe(1);
  });

  it("says nothing for a plain file", () => {
    expect(openedNotice("w.pdb", { warnings: [] })).toBeNull();
  });

  it("names the frame taken, the warnings and the ignored files", () => {
    const meta = { nFrames: 5, timestepPs: 1, nAtoms: 3 };
    expect(openedNotice("t.xyz", { meta })).toBe(
      "Opened frame 1 of 5 of t.xyz. The Builder edits one frame.",
    );
    expect(openedNotice("w.pdb", { warnings: ["bad line 3", "bad line 9", "x"] })).toBe(
      "Opened w.pdb with 3 warnings: bad line 3.",
    );
    expect(openedNotice("t.xyz", { meta, warnings: ["odd"] })).toBe(
      "Opened frame 1 of 5 of t.xyz with 1 warning: odd.",
    );
    expect(openedNotice("w.pdb", {}, 1)).toBe(
      "Opened w.pdb. 1 other file was ignored: the Builder opens one file at a time.",
    );
    expect(openedNotice("w.pdb", {}, 2)).toContain("2 other files were ignored");
  });
});

describe("openStructureFile", () => {
  it("opens a file and reports its warnings in an info notice", async () => {
    const api = createBuilderStore();
    parseStructureFile.mockResolvedValue(parsed({ warnings: ["skipped HETATM"] }));
    expect(await openStructureFile(new File(["x"], "w.pdb"), api)).toBe(true);
    expect(api.getState().fileName).toBe("w.pdb");
    expect(api.getState().notice).toEqual({
      level: "info",
      text: "Opened w.pdb with 1 warning: skipped HETATM.",
    });
  });

  it("asks before replacing unsaved edits; Cancel keeps the document", async () => {
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "mine.xyz");
    api.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    parseStructureFile.mockResolvedValue(parsed());

    const cancelled = openStructureFile(new File(["x"], "other.pdb"), api);
    await settle();
    expect(api.getState().confirm?.message).toContain("Opening other.pdb replaces");
    api.getState().resolveConfirm(false);
    expect(await cancelled).toBe(false);
    expect(api.getState().fileName).toBe("mine.xyz");
    expect(api.getState().edits).toHaveLength(1);

    const accepted = openStructureFile(new File(["x"], "other.pdb"), api);
    await settle();
    api.getState().resolveConfirm(true);
    expect(await accepted).toBe(true);
    expect(api.getState().fileName).toBe("other.pdb");
  });

  it("a file that does not parse never asks", async () => {
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "mine.xyz");
    api.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    parseStructureFile.mockRejectedValue(new Error("garbled"));
    expect(await openStructureFile(new File(["x"], "bad.pdb"), api)).toBe(false);
    expect(api.getState().confirm).toBeNull();
    expect(api.getState().notice).toEqual({
      level: "error",
      text: "Could not open bad.pdb: garbled",
    });
  });
});

describe("openStructureFiles", () => {
  it("opens the first of several and says the rest were ignored", async () => {
    const api = createBuilderStore();
    parseStructureFile.mockResolvedValue(parsed());
    const files = [new File(["x"], "a.pdb"), new File(["y"], "b.pdb")];
    expect(await openStructureFiles(files, api)).toBe(true);
    expect(parseStructureFile).toHaveBeenCalledTimes(1);
    expect(api.getState().fileName).toBe("a.pdb");
    expect(api.getState().notice?.text).toContain("1 other file was ignored");
    expect(await openStructureFiles([], api)).toBe(false);
  });
});
