import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: vi.fn(),
  parseDCDFile: vi.fn(),
  parseLammpstrjFile: vi.fn(),
  parseNetCDFFile: vi.fn(),
}));

import { parseXTCFile, parseDCDFile, parseLammpstrjFile, parseNetCDFFile } from "@/parsers/xtc";
import type { XTCParseResult } from "@/parsers/xtc";
import { parseTrajectoryByName } from "@/parsers/trajectoryDispatch";
import type { Frame } from "@/types";

const parsers = {
  xtc: vi.mocked(parseXTCFile),
  dcd: vi.mocked(parseDCDFile),
  lammpstrj: vi.mocked(parseLammpstrjFile),
  netcdf: vi.mocked(parseNetCDFFile),
};

function uniformResult(): XTCParseResult {
  return {
    frames: [{ frameId: 1, nAtoms: 2, positions: new Float32Array(6) }],
    meta: { nFrames: 1, timestepPs: 1, nAtoms: 2 },
    vectorChannels: [],
  };
}

/** A variable-atom LAMMPS dump: raw type ids (1, 2) as per-frame elements. */
function heteroDumpResult(): XTCParseResult {
  const frames: Frame[] = [
    { frameId: 0, nAtoms: 2, positions: new Float32Array(6), elements: Uint8Array.from([1, 2]) },
    {
      frameId: 1,
      nAtoms: 3,
      positions: new Float32Array(9),
      elements: Uint8Array.from([2, 1, 3]),
    },
  ];
  return {
    frames,
    meta: { nFrames: 2, timestepPs: 1, nAtoms: 2, variesTopology: true, heterogeneous: true },
    vectorChannels: [],
  };
}

beforeEach(() => {
  for (const p of Object.values(parsers)) {
    p.mockReset();
    p.mockResolvedValue(uniformResult());
  }
});

describe("parseTrajectoryByName — dispatch", () => {
  it.each([
    ["run.xtc", "xtc"],
    ["RUN.XTC", "xtc"],
    ["traj.dcd", "dcd"],
    ["md.nc", "netcdf"],
    ["dump.lammpstrj", "lammpstrj"],
    ["atoms.dump", "lammpstrj"],
    ["atoms.trj", "lammpstrj"],
  ] as const)("routes %s to the %s parser", async (name, kind) => {
    const file = new File(["x"], name);
    const out = await parseTrajectoryByName(file, 2);
    expect(parsers[kind]).toHaveBeenCalledWith(file, 2);
    for (const [other, fn] of Object.entries(parsers)) {
      if (other !== kind) expect(fn).not.toHaveBeenCalled();
    }
    expect(out).toEqual(uniformResult());
  });

  it("rejects an extension that is not a trajectory format", async () => {
    await expect(parseTrajectoryByName(new File(["x"], "run.trr"), 2)).rejects.toThrow(
      /Unsupported trajectory format: run\.trr/,
    );
    await expect(parseTrajectoryByName(new File(["x"], "noext"), 2)).rejects.toThrow(
      /expected one of \.xtc/,
    );
    for (const fn of Object.values(parsers)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("parseTrajectoryByName — LAMMPS type→element remap", () => {
  it("maps a variable-atom dump's type ids to the structure's elements", async () => {
    const parsed = heteroDumpResult();
    parsers.lammpstrj.mockResolvedValueOnce(parsed);
    const out = await parseTrajectoryByName(
      new File(["x"], "gcmc.lammpstrj"),
      2,
      Uint8Array.from([6, 8]),
    );
    expect(Array.from(out.frames[0].elements!)).toEqual([6, 8]);
    // Type 3 never appears in frame 0 → unknown (0).
    expect(Array.from(out.frames[1].elements!)).toEqual([8, 6, 0]);
    expect(out.meta).toBe(parsed.meta);
    // The parser's own output stays as-read (CRITICAL RULE #11).
    expect(Array.from(parsed.frames[0].elements!)).toEqual([1, 2]);
  });

  it("leaves frames untouched without structure elements", async () => {
    const parsed = heteroDumpResult();
    parsers.lammpstrj.mockResolvedValueOnce(parsed);
    const out = await parseTrajectoryByName(new File(["x"], "gcmc.dump"), 2, null);
    expect(out).toBe(parsed);
  });

  it("leaves a fixed-topology trajectory untouched", async () => {
    const parsed = heteroDumpResult();
    parsed.meta = { nFrames: 2, timestepPs: 1, nAtoms: 2 };
    parsers.lammpstrj.mockResolvedValueOnce(parsed);
    const out = await parseTrajectoryByName(
      new File(["x"], "fixed.lammpstrj"),
      2,
      Uint8Array.from([6, 8]),
    );
    expect(out).toBe(parsed);
  });
});
