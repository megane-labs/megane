import { describe, it, expect } from "vitest";
import {
  AXIS_KEYS,
  MAX_CONTACT_PAIRS,
  axisVector,
  centroid,
  closeContacts,
  dragDisplacements,
  dragModeFor,
  moveOps,
  readoutLabel,
  rotateDisplacements,
  translateDisplacements,
  type DragOptions,
  type Vec3,
} from "@/builder/manipulate";
import { hoverHighlight, HOVER_COLORS, type HoverState } from "@/builder/hover";
import type { BuildDragGesture } from "@/builder/types";
import type { Snapshot } from "@/types";

/**
 * A drag of (dx, dy) px, looking down −z (screen right = +x, up = +y,
 * toward the camera = +z) at 0.1 Å per pixel; the origin is at pixel (100, 100).
 */
function gesture(
  dx: number,
  dy: number,
  from: [number, number] = [100, 100],
  camera: Partial<Pick<BuildDragGesture, "right" | "up" | "toCamera">> = {},
): BuildDragGesture {
  return {
    from,
    to: [from[0] + dx, from[1] + dy],
    right: [1, 0, 0],
    up: [0, 1, 0],
    toCamera: [0, 0, 1],
    worldPerPixel: 0.1,
    project: (p) => [100 + p[0] * 10, 100 - p[1] * 10],
    ...camera,
  };
}

const FREE: DragOptions = { axis: null, snap: false };
const SNAP: DragOptions = { axis: null, snap: true };
const along = (key: "x" | "y" | "z", snap = false): DragOptions => ({
  axis: { key, vector: axisVector(key, null)! },
  snap,
});

/** Two atoms 2 Å apart on x, centred on the origin. */
const PAIR = new Float32Array([-1, 0, 0, 1, 0, 0]);

function expectVec(actual: Vec3 | undefined, expected: Vec3) {
  expect(actual).toBeDefined();
  actual!.forEach((v, k) => expect(v).toBeCloseTo(expected[k], 6));
}

describe("dragModeFor", () => {
  it("maps the modifiers held at the press to a motion", () => {
    expect(dragModeFor({ shiftKey: false, mod: false })).toBe("translate");
    expect(dragModeFor({ shiftKey: true, mod: false })).toBe("depth");
    expect(dragModeFor({ shiftKey: false, mod: true })).toBe("rotate");
    expect(dragModeFor({ shiftKey: true, mod: true })).toBe("spin");
  });
});

describe("axisVector and centroid", () => {
  it("gives unit Cartesian axes, and the cell's vectors only with a cell", () => {
    expect(axisVector("y", null)).toEqual([0, 1, 0]);
    expect(axisVector("a", null)).toBeNull();
    const box = new Float32Array([2, 0, 0, 1, 1, 0, 0, 0, 0]);
    expectVec(axisVector("b", box)!, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    expect(axisVector("c", box)).toBeNull();
    expect(axisVector("a", new Float32Array(3))).toBeNull();
    expect(AXIS_KEYS).toEqual(["x", "y", "z", "a", "b", "c"]);
  });

  it("averages the chosen atoms", () => {
    expect(centroid(new Float32Array([0, 0, 0, 2, 4, 6, 9, 9, 9]), [0, 1])).toEqual([1, 2, 3]);
    expect(centroid(PAIR, [])).toEqual([0, 0, 0]);
  });
});

describe("dragDisplacements — moves", () => {
  it("translates in the screen plane, rounding each component with Snap", () => {
    const free = dragDisplacements(PAIR, [0, 1], "translate", gesture(12, -7), FREE);
    expectVec(free.displacements.get(0), [1.2, 0.7, 0]);
    expectVec(free.displacements.get(1), [1.2, 0.7, 0]);
    expect(free.readout.kind).toBe("move");
    expect(free.readout.value).toBeCloseTo(Math.hypot(1.2, 0.7), 6);
    const snapped = dragDisplacements(PAIR, [0], "translate", gesture(12.6, -7.4), SNAP);
    expectVec(snapped.displacements.get(0), [1.3, 0.7, 0]);
  });

  it("moves in depth with Shift: down toward the viewer, up away", () => {
    const toward = dragDisplacements(PAIR, [0], "depth", gesture(50, 10), FREE);
    expectVec(toward.displacements.get(0), [0, 0, 1]);
    const away = dragDisplacements(PAIR, [0], "depth", gesture(0, -12.6), SNAP);
    expectVec(away.displacements.get(0), [0, 0, -1.3]);
  });

  it("follows a locked axis by the part of the drag along its image on screen", () => {
    const x = dragDisplacements(PAIR, [0], "translate", gesture(10, 30), along("x"));
    expectVec(x.displacements.get(0), [1, 0, 0]);
    expect(x.readout).toMatchObject({ kind: "move", axis: "x" });
    expect(x.readout.value).toBeCloseTo(1, 6);
    // A depth drag locked to an on-screen axis moves along it the same way.
    const y = dragDisplacements(PAIR, [0], "depth", gesture(0, -12.6), along("y", true));
    expectVec(y.displacements.get(0), [0, 1.3, 0]);
  });

  it("moves along an axis that points at the viewer by the vertical drag", () => {
    const toward = dragDisplacements(PAIR, [0], "translate", gesture(0, 10), along("z"));
    expectVec(toward.displacements.get(0), [0, 0, 1]);
    // Seen from below (z points away from the viewer) the sense flips.
    const below = dragDisplacements(
      PAIR,
      [0],
      "translate",
      gesture(0, 10, [100, 100], { toCamera: [0, 0, -1] }),
      along("z"),
    );
    expectVec(below.displacements.get(0), [0, 0, -1]);
  });
});

describe("dragDisplacements — turns", () => {
  it("turns like a trackball about the selection's centre", () => {
    // 180 px right at 0.5°/px: 90° about the screen's up axis (+y).
    const yaw = dragDisplacements(PAIR, [0, 1], "rotate", gesture(180, 0), FREE);
    expectVec(yaw.displacements.get(1), [-1, 0, -1]);
    expectVec(yaw.displacements.get(0), [1, 0, 1]);
    expect(yaw.readout).toMatchObject({ kind: "rotate", axis: null });
    expect(yaw.readout.value).toBeCloseTo(90, 6);
    // Down turns about the screen's right axis (+x): y goes toward the viewer.
    const atoms = new Float32Array([0, 1, 0, 0, -1, 0]);
    const pitch = dragDisplacements(atoms, [0, 1], "rotate", gesture(0, 180), FREE);
    expectVec(pitch.displacements.get(0), [0, -1, 1]);
  });

  it("snaps both trackball angles to 15° and reports the combined turn", () => {
    const t = dragDisplacements(PAIR, [0, 1], "rotate", gesture(56, 4), SNAP);
    // 28° → 30° of yaw, 2° → 0° of pitch.
    expect(t.readout.value).toBeCloseTo(30, 6);
    expectVec(t.displacements.get(1), [Math.cos(Math.PI / 6) - 1, 0, -0.5]);
  });

  it("spins about the line of sight as the pointer goes round the centre", () => {
    // From the right of the centre (origin, pixel 100,100) to above it: a
    // quarter turn counter-clockwise on screen.
    const spin = dragDisplacements(PAIR, [0, 1], "spin", gesture(-20, -20, [120, 100]), FREE);
    expect(spin.readout.value).toBeCloseTo(90, 6);
    expectVec(spin.displacements.get(1), [-1, 1, 0]);
    // Too near the centre to tell a direction: no turn.
    const near = dragDisplacements(PAIR, [0, 1], "spin", gesture(30, 0, [101, 100]), FREE);
    expect(near.readout.value).toBe(0);
    // Past half a turn the angle wraps instead of jumping.
    const wrapped = dragDisplacements(PAIR, [0, 1], "spin", gesture(-40, -1, [120, 100]), SNAP);
    expect(Math.abs(wrapped.readout.value)).toBeLessThanOrEqual(180);
  });

  it("turns about a locked axis: by the horizontal drag, or by the spin", () => {
    const r = dragDisplacements(PAIR, [0, 1], "rotate", gesture(185, 50), along("z", true));
    expect(r.readout).toMatchObject({ kind: "rotate", value: 90, axis: "z" });
    expectVec(r.displacements.get(1), [-1, 1, 0]);
    const s = dragDisplacements(PAIR, [0, 1], "spin", gesture(-20, -20, [120, 100]), along("z"));
    expect(s.readout.value).toBeCloseTo(90, 6);
    // An axis pointing away from the viewer turns the other way for the same gesture.
    const away = dragDisplacements(
      PAIR,
      [0, 1],
      "spin",
      gesture(-20, -20, [120, 100], { toCamera: [0, 0, -1] }),
      along("z"),
    );
    expect(away.readout.value).toBeCloseTo(-90, 6);
  });
});

describe("readoutLabel", () => {
  it("says what a drag did", () => {
    expect(readoutLabel({ kind: "move", value: 1.234, delta: [1, 0.5, 0], axis: null })).toBe(
      "Move 1.23 Å (1.00, 0.50, 0.00)",
    );
    expect(readoutLabel({ kind: "move", value: -0.5, delta: null, axis: "a" })).toBe(
      "Move -0.50 Å along a",
    );
    expect(readoutLabel({ kind: "rotate", value: 30, delta: null, axis: null })).toBe(
      "Rotate 30.0°",
    );
    expect(readoutLabel({ kind: "rotate", value: 15, delta: null, axis: "z" })).toBe(
      "Rotate 15.0° about z",
    );
  });
});

function snapshot(positions: number[], elements: number[], bonds: number[] = []): Snapshot {
  return {
    nAtoms: elements.length,
    nBonds: bonds.length / 2,
    nFileBonds: bonds.length / 2,
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(bonds),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

describe("closeContacts", () => {
  it("flags non-bonded pairs between moved and fixed atoms that are too close", () => {
    // H0–C1 bonded at 1.0 Å; H2 1.0 Å from H0 (limit 1.2 Å for two H); C3 far.
    const s = snapshot([0, 0, 0, 1, 0, 0, -1, 0, 0, 9, 9, 9], [1, 6, 1, 6], [0, 1]);
    expect(closeContacts(s, [0])).toEqual([0, 2]);
    // Moved atoms among themselves never count.
    expect(closeContacts(s, [0, 2])).toEqual([]);
    expect(closeContacts(s, [])).toEqual([]);
  });

  it("skips the check when it would be too large", () => {
    const n = Math.ceil(Math.sqrt(MAX_CONTACT_PAIRS)) + 1;
    const s = snapshot(new Array(n * 3).fill(0), new Array(n).fill(1));
    expect(
      closeContacts(
        s,
        Array.from({ length: n }, (_, i) => i),
      ),
    ).toEqual([]);
  });
});

describe("Transform helpers and moveOps", () => {
  it("translates every atom by the same vector", () => {
    const d = translateDisplacements([0, 1], [1, 2, 3]);
    expect([...d]).toEqual([
      [0, [1, 2, 3]],
      [1, [1, 2, 3]],
    ]);
  });

  it("turns about an axis through the atoms' centre", () => {
    const d = rotateDisplacements(PAIR, [0, 1], [0, 0, 1], 180);
    expectVec(d.get(0), [2, 0, 0]);
    expectVec(d.get(1), [-2, 0, 0]);
  });

  it("groups equal displacements into one op, keeps atom 0 and drops zero moves", () => {
    const refs = new Map<number, number | string>([
      [0, 0],
      [1, "n1"],
      [2, 2],
    ]);
    const ops = moveOps(
      new Map<number, Vec3>([
        [0, [1, 0, 0]],
        [1, [1, 0, 0]],
        [2, [0, 0, 0]],
        [3, [5, 5, 5]], // no ref: not in the document
      ]),
      refs as never,
    );
    expect(ops).toEqual([{ op: "move_atoms", atoms: [0, "n1"], delta: [1, 0, 0] }]);
  });
});

describe("hoverHighlight", () => {
  const base: HoverState = {
    tool: "select",
    editable: true,
    pendingBondAtom: null,
    adsorbOnAtoms: false,
    dragging: false,
  };

  it("marks the atom under the pointer in the colour of what a click does", () => {
    expect(hoverHighlight(3, base)).toEqual({ atoms: [3], color: HOVER_COLORS.select });
    expect(hoverHighlight(3, { ...base, tool: "move" })?.color).toBe(HOVER_COLORS.select);
    expect(hoverHighlight(3, { ...base, tool: "delete" })?.color).toBe(HOVER_COLORS.delete);
    expect(hoverHighlight(3, { ...base, tool: "element" })?.color).toBe(HOVER_COLORS.element);
    expect(hoverHighlight(3, { ...base, tool: "add" })?.color).toBe(HOVER_COLORS.attach);
    expect(hoverHighlight(3, { ...base, tool: "place", adsorbOnAtoms: true })?.color).toBe(
      HOVER_COLORS.attach,
    );
  });

  it("joins the pending bond atom to the hovered one", () => {
    const bond = { ...base, tool: "bond" as const };
    expect(hoverHighlight(3, bond)?.atoms).toEqual([3]);
    expect(hoverHighlight(3, { ...bond, pendingBondAtom: 1 })?.atoms).toEqual([1, 3]);
    expect(hoverHighlight(1, { ...bond, pendingBondAtom: 1 })?.atoms).toEqual([1]);
  });

  it("marks nothing where a click would do nothing", () => {
    expect(hoverHighlight(null, base)).toBeNull();
    expect(hoverHighlight(3, { ...base, dragging: true })).toBeNull();
    expect(hoverHighlight(3, { ...base, tool: "place" })).toBeNull();
    for (const tool of ["delete", "element", "add", "bond", "place"] as const) {
      expect(hoverHighlight(3, { ...base, tool, editable: false, adsorbOnAtoms: true })).toBeNull();
    }
    // Selecting works on a paused document too.
    expect(hoverHighlight(3, { ...base, editable: false })).not.toBeNull();
  });
});
