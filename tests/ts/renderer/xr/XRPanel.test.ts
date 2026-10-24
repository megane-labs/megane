import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as THREE from "three";
import {
  drawPanel,
  fitText,
  hitControl,
  layoutPanel,
  panelSize,
  scrubFrame,
  XRPanel,
  XR_EDIT_PANEL_PX_WIDTH,
  XR_PANEL_COMPACT,
  XR_PANEL_PX_PER_M,
  type XREditPanel,
  XR_PANEL_HEIGHT,
  XR_PANEL_PX_HEIGHT,
  XR_PANEL_PX_WIDTH,
  XR_PANEL_WIDTH,
  type XRPanelRect,
  type XRPanelState,
} from "@/renderer/xr/XRPanel";
import { XR_EDIT_PANEL_PLACEMENT, XR_PANEL_DISTANCE, XR_PANEL_DROP } from "@/renderer/xr/xrMath";
import { fakeContext2D, stubCanvas2D, type FakeContext2D } from "./fakeCanvas";

const full: XRPanelState = {
  playback: { frame: 4, total: 10, playing: false },
  measure: { active: false, hasSelection: true, label: null },
};
const bare: XRPanelState = { playback: null, measure: null };

/** Panel coordinates (0–1) of a control's centre. */
function centre(r: XRPanelRect): [number, number] {
  return [(r.x + r.w / 2) / XR_PANEL_PX_WIDTH, (r.y + r.h / 2) / XR_PANEL_PX_HEIGHT];
}

const byId = (rects: XRPanelRect[], id: string) => rects.find((r) => r.id === id)!;

describe("layoutPanel", () => {
  it("lays out playback, measure and the actions within the panel", () => {
    const rects = layoutPanel(full);
    expect(rects.map((r) => r.id)).toEqual([
      "prev",
      "play",
      "next",
      "scrub",
      "measure",
      "clear",
      "reset",
      "exit",
    ]);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(XR_PANEL_PX_WIDTH + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(XR_PANEL_PX_HEIGHT);
      expect(r.enabled).toBe(true);
    }
  });

  it("disables what cannot be used and leaves out what is not offered", () => {
    const single = layoutPanel({
      playback: { frame: 0, total: 1, playing: false },
      measure: { active: true, hasSelection: false, label: null },
    });
    expect(byId(single, "play").enabled).toBe(false);
    expect(byId(single, "scrub").enabled).toBe(false);
    expect(byId(single, "clear").enabled).toBe(false);
    // Builder: just Reset and Exit, sharing the row.
    const rects = layoutPanel(bare);
    expect(rects.map((r) => r.id)).toEqual(["reset", "exit"]);
    expect(rects[0].w).toBeGreaterThan(300);
  });
});

describe("hitControl", () => {
  const rects = layoutPanel(full);

  it("finds the enabled control under a point", () => {
    expect(hitControl(rects, ...centre(byId(rects, "play")))?.id).toBe("play");
    expect(hitControl(rects, ...centre(byId(rects, "exit")))?.id).toBe("exit");
    // Between the controls: nothing.
    expect(hitControl(rects, 0.5, 0.02)).toBeNull();
    const disabled = layoutPanel({ ...full, measure: { ...full.measure!, hasSelection: false } });
    expect(hitControl(disabled, ...centre(byId(disabled, "clear")))).toBeNull();
  });

  it("reports how far along the scrub bar, and keeps a grabbed bar past its ends", () => {
    const scrub = byId(rects, "scrub");
    const [, v] = centre(scrub);
    const quarter = (scrub.x + scrub.w / 4) / XR_PANEL_PX_WIDTH;
    expect(hitControl(rects, quarter, v)?.fraction).toBeCloseTo(0.25, 9);
    // Grabbed: only the bar answers, clamped, wherever the ray is.
    expect(hitControl(rects, 1.2, 0.9, "scrub")).toEqual({ id: "scrub", fraction: 1 });
    expect(hitControl(rects, -0.2, 0.1, "scrub")).toEqual({ id: "scrub", fraction: 0 });
    expect(hitControl(rects, 0.5, 0.5, "measure")?.id).toBe("measure");
  });
});

describe("scrubFrame", () => {
  it("maps a fraction onto the trajectory's frames", () => {
    expect(scrubFrame(0, 10)).toBe(0);
    expect(scrubFrame(1, 10)).toBe(9);
    expect(scrubFrame(0.5, 11)).toBe(5);
    expect(scrubFrame(2, 10)).toBe(9);
    expect(scrubFrame(-1, 10)).toBe(0);
    expect(scrubFrame(0.5, 0)).toBe(0);
  });
});

describe("drawPanel", () => {
  let ctx: FakeContext2D;
  beforeEach(() => {
    ctx = fakeContext2D();
  });

  it("draws the frame counter, the measure hint and every control", () => {
    const state: XRPanelState = {
      playback: { frame: 4, total: 10, playing: true },
      measure: { active: true, hasSelection: false, label: null },
    };
    drawPanel(ctx, state, layoutPanel(state), new Set(["scrub"]), new Set(["next"]));
    expect(ctx.texts).toEqual(
      expect.arrayContaining(["Frame 5 / 10", "Point at an atom, then pinch", "Measure", "Exit"]),
    );
    // The scrub knob and the icons are paths.
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.rect).toHaveBeenCalled();
  });

  it("shows the measurement and the no-trajectory note", () => {
    const state: XRPanelState = {
      playback: null,
      measure: { active: false, hasSelection: true, label: "1.234 Å" },
    };
    drawPanel(ctx, state, layoutPanel(state), new Set(["measure"]), new Set(["reset"]));
    expect(ctx.texts).toEqual(
      expect.arrayContaining(["Megane", "1.234 Å", "No trajectory to play", "Clear"]),
    );
  });

  it("draws a paused play button and disabled single-frame controls", () => {
    const state: XRPanelState = {
      playback: { frame: 0, total: 1, playing: false },
      measure: null,
    };
    drawPanel(ctx, state, layoutPanel(state), new Set(), new Set(["scrub"]));
    expect(ctx.texts).toContain("Frame 1 / 1");
    expect(ctx.moveTo).toHaveBeenCalled();
  });
});

describe("XRPanel", () => {
  let contexts: FakeContext2D[];
  beforeEach(() => {
    contexts = stubCanvas2D();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const head = new THREE.Vector3(0, 1.6, 0);
  const ahead = new THREE.Quaternion();

  /** A ray 30 cm in front of the panel pointing straight at control `id`. */
  function rayAt(panel: XRPanel, id: Parameters<XRPanel["controlPose"]>[0]): THREE.Ray {
    const pose = panel.controlPose(id)!;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    return new THREE.Ray(pose.position, dir);
  }

  it("is hidden until placed in front of the head", () => {
    const panel = new XRPanel();
    expect(panel.mesh.visible).toBe(false);
    expect(panel.hit(new THREE.Ray())).toBeNull();
    expect(panel.covers(new THREE.Ray())).toBeNull();
    expect(panel.controlPose("exit")).toBeNull();
    panel.follow(head, ahead, 0.016);
    expect(panel.mesh.visible).toBe(true);
    expect(panel.mesh.position.z).toBeCloseTo(-XR_PANEL_DISTANCE, 9);
    expect(panel.mesh.position.y).toBeCloseTo(1.6 - XR_PANEL_DROP, 9);
    expect(panel.mesh.renderOrder).toBe(1000);
    expect(panel.mesh.material.depthTest).toBe(false);
  });

  it("redraws only when what it shows changes", () => {
    const panel = new XRPanel();
    const ctx = contexts[0];
    panel.update(full, [], []);
    const draws = vi.mocked(ctx.clearRect).mock.calls.length;
    expect(draws).toBe(1);
    panel.update({ ...full }, [], []);
    expect(vi.mocked(ctx.clearRect).mock.calls.length).toBe(1);
    panel.update(full, ["play"], []);
    expect(vi.mocked(ctx.clearRect).mock.calls.length).toBe(2);
    expect(panel.controls).toEqual([
      "prev",
      "play",
      "next",
      "scrub",
      "measure",
      "clear",
      "reset",
      "exit",
    ]);
  });

  it("hit-tests rays against its controls", () => {
    const panel = new XRPanel();
    panel.update(full, [], []);
    panel.follow(head, ahead, 0.016);
    for (const id of ["play", "measure", "exit"] as const) {
      const hit = panel.hit(rayAt(panel, id))!;
      expect(hit.id).toBe(id);
      expect(hit.distance).toBeCloseTo(0.15, 6);
    }
    // A ray that misses the panel entirely.
    expect(panel.hit(new THREE.Ray(head, new THREE.Vector3(0, 1, 0)))).toBeNull();
    // Through the status row: on the panel, but on no control.
    const pose = panel.controlPose("play")!;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
    const statusRay = new THREE.Ray(
      pose.position.clone().addScaledVector(up, XR_PANEL_HEIGHT * 0.33),
      new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion),
    );
    expect(panel.hit(statusRay)).toBeNull();
    expect(panel.covers(statusRay)).toBeCloseTo(0.15, 6);
    // A grabbed scrub bar answers past the panel's edge.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
    const pastEdge = new THREE.Ray(
      pose.position.clone().addScaledVector(right, XR_PANEL_WIDTH),
      new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion),
    );
    expect(panel.hit(pastEdge)).toBeNull();
    expect(panel.hit(pastEdge, "scrub")).toMatchObject({ id: "scrub", fraction: 1 });
  });

  it("stays put for a glance and glides back once out of reach", () => {
    const panel = new XRPanel();
    panel.follow(head, ahead, 0.016);
    const start = panel.mesh.position.clone();
    const glance = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
    panel.follow(head, glance, 0.1);
    expect(panel.mesh.position.distanceTo(start)).toBe(0);
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    // A hand using the panel holds it still.
    panel.follow(head, turned, 0.1, false, true);
    expect(panel.mesh.position.distanceTo(start)).toBe(0);
    panel.follow(head, turned, 0.1);
    const moved = panel.mesh.position.clone();
    expect(moved.distanceTo(start)).toBeGreaterThan(0.01);
    // It keeps gliding until it arrives, then settles.
    for (let i = 0; i < 100; i++) panel.follow(head, turned, 0.1);
    // Within a centimetre of where it belongs, it stops.
    expect(Math.abs(panel.mesh.position.x + XR_PANEL_DISTANCE)).toBeLessThan(0.011);
    const settled = panel.mesh.position.clone();
    panel.follow(head, turned, 0.1);
    expect(panel.mesh.position.distanceTo(settled)).toBe(0);
    // A snap puts it straight in front.
    panel.follow(head, ahead, 0.016, true);
    expect(panel.mesh.position.distanceTo(start)).toBeCloseTo(0, 9);
  });

  it("reset hides it until the next placement; dispose frees it", () => {
    const panel = new XRPanel();
    const parent = new THREE.Group();
    parent.add(panel.mesh);
    panel.follow(head, ahead, 0.016);
    panel.reset();
    expect(panel.mesh.visible).toBe(false);
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    panel.follow(head, turned, 0.016);
    expect(panel.mesh.position.z).toBeCloseTo(XR_PANEL_DISTANCE, 9);
    const dispose = vi.spyOn(panel.mesh.geometry, "dispose");
    panel.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(panel.mesh.parent).toBeNull();
  });

  it("works without a 2D context", () => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const panel = new XRPanel();
    expect(() => panel.update(full, [], [])).not.toThrow();
  });
});

/** An editing page's panel: a tool row, a gapped row, and actions. */
const editing: XREditPanel = {
  title: "Add atom · C · single",
  summary: "24 atoms · 2 selected",
  detail: "Pinch an atom to attach a new one",
  detailLevel: "hint",
  rows: [
    [
      { id: "tool:select", label: "Select" },
      { id: "tool:add", label: "Add atom", active: true },
    ],
    [
      { id: "element:6", label: "C", swatch: "rgb(128, 128, 128)" },
      { id: "", label: "", spacer: true, span: 2 },
      { id: "element:8", label: "O", enabled: false },
    ],
  ],
  actions: [{ id: "undo", label: "Undo" }],
};
const editState: XRPanelState = { playback: null, measure: null, edit: editing };

describe("the editing panel", () => {
  it("lays out the page's rows, then its actions before Reset and Exit", () => {
    const rects = layoutPanel(editState);
    expect(rects.map((r) => r.id)).toEqual([
      "edit:tool:select",
      "edit:tool:add",
      "edit:element:6",
      "edit:element:8",
      "edit:undo",
      "reset",
      "exit",
    ]);
    const size = panelSize(editState);
    expect(size.pxWidth).toBe(XR_EDIT_PANEL_PX_WIDTH);
    expect(size.width).toBeCloseTo(XR_EDIT_PANEL_PX_WIDTH / XR_PANEL_PX_PER_M, 9);
    expect(size.height).toBeCloseTo(size.pxHeight / XR_PANEL_PX_PER_M, 9);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(size.pxWidth + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(size.pxHeight);
    }
    // A spacer leaves its spans of room: O sits three cells along from C.
    const c = byId(rects, "edit:element:6");
    const o = byId(rects, "edit:element:8");
    expect(o.w).toBeCloseTo(c.w, 9);
    expect(o.x + o.w).toBeCloseTo(XR_EDIT_PANEL_PX_WIDTH - 24, 6);
    expect((o.x - c.x) / 3).toBeGreaterThan(c.w);
    expect(o.enabled).toBe(false);
    // The actions share the bottom row.
    expect(byId(rects, "exit").y).toBe(byId(rects, "edit:undo").y);
    expect(byId(rects, "edit:undo").y).toBeGreaterThan(o.y + o.h);
  });

  it("grows with its rows and packs a grid (the periodic table) tighter", () => {
    const one = panelSize({ ...editState, edit: { ...editing, rows: [editing.rows[0]] } });
    const two = panelSize(editState);
    expect(two.pxHeight).toBeGreaterThan(one.pxHeight);
    const grid = Array.from({ length: 9 }, (_, i) => [{ id: `z${i}`, label: "H" }]);
    const table = { ...editState, edit: { ...editing, rows: grid } };
    const rects = layoutPanel(table);
    const first = byId(rects, "edit:z0");
    const second = byId(rects, "edit:z1");
    const cell = byId(rects, "edit:tool:add");
    expect(first.h).toBeLessThan(byId(layoutPanel(editState), "edit:tool:add").h);
    expect(second.y - first.y - first.h).toBeLessThan(10);
    expect(cell).toBeUndefined();
    expect(panelSize(table).pxHeight).toBeGreaterThan(two.pxHeight);
    // Without rows the panel is just the status block and the actions.
    const empty = { ...editState, edit: { ...editing, rows: [] } };
    expect(panelSize(empty).pxHeight).toBeLessThan(one.pxHeight);
    expect(layoutPanel(empty).map((r) => r.id)).toEqual(["edit:undo", "reset", "exit"]);
  });

  it("finds its buttons in its own pixel space", () => {
    const rects = layoutPanel(editState);
    const size = panelSize(editState);
    const r = byId(rects, "edit:tool:add");
    const u = (r.x + r.w / 2) / size.pxWidth;
    const v = (r.y + r.h / 2) / size.pxHeight;
    expect(hitControl(rects, u, v, null, size)?.id).toBe("edit:tool:add");
    // A disabled button does not answer.
    const o = byId(rects, "edit:element:8");
    expect(
      hitControl(rects, (o.x + 1) / size.pxWidth, (o.y + 1) / size.pxHeight, null, size),
    ).toBeNull();
    expect(XR_PANEL_COMPACT.pxWidth).toBe(XR_PANEL_PX_WIDTH);
  });

  it("draws the status block, the labels and the swatches", () => {
    const ctx = fakeContext2D();
    drawPanel(ctx, editState, layoutPanel(editState), new Set(["edit:tool:select"]), new Set());
    expect(ctx.texts).toEqual(
      expect.arrayContaining([
        "Add atom · C · single",
        "24 atoms · 2 selected",
        "Pinch an atom to attach a new one",
        "Select",
        "C",
        "Undo",
        "Reset",
        "Exit",
      ]),
    );
    // Playback has no place on an editing panel.
    expect(ctx.texts).not.toContain("No trajectory to play");
  });

  it("paints a button's swatch in its colour", () => {
    const ctx = fakeContext2D();
    const fills: string[] = [];
    Object.defineProperty(ctx, "fillStyle", {
      set: (f: string) => fills.push(f),
      get: () => fills[fills.length - 1],
    });
    drawPanel(ctx, editState, layoutPanel(editState), new Set(), new Set());
    expect(fills).toContain("rgb(128, 128, 128)");
  });

  it("shows notices plainly and errors in red, without a summary or detail too", () => {
    for (const level of ["info", "error"] as const) {
      const ctx = fakeContext2D();
      const edit = { ...editing, summary: undefined, detail: `a ${level}`, detailLevel: level };
      const state = { ...editState, edit };
      drawPanel(ctx, state, layoutPanel(state), new Set(), new Set(["edit:undo"]));
      expect(ctx.texts).toContain(`a ${level}`);
    }
    const ctx = fakeContext2D();
    const bare = { ...editState, edit: { ...editing, summary: undefined, detail: undefined } };
    drawPanel(ctx, bare, layoutPanel(bare), new Set(), new Set());
    expect(ctx.texts[0]).toBe("Add atom · C · single");
  });

  it("shrinks a long label to fit its button, then cuts it short", () => {
    const ctx = fakeContext2D();
    const long = "x".repeat(40);
    const state = {
      ...editState,
      edit: { ...editing, rows: [], actions: [{ id: "a", label: long }] },
    };
    const fonts: string[] = [];
    Object.defineProperty(ctx, "font", {
      set: (f: string) => fonts.push(f),
      get: () => fonts[fonts.length - 1],
    });
    drawPanel(ctx, state, layoutPanel(state), new Set(), new Set());
    expect(fonts.some((f) => f.includes(" 16px "))).toBe(true);
    expect(ctx.texts.some((t) => t.endsWith("…"))).toBe(true);
  });
});

describe("fitText", () => {
  it("keeps text that fits and cuts the rest short with an ellipsis", () => {
    const ctx = fakeContext2D();
    expect(fitText(ctx, "short", 100)).toBe("short");
    // 10 px a character: 9 of them and the ellipsis fit 100 px.
    expect(fitText(ctx, "a long line of text", 100)).toBe("a long li…");
    expect(fitText(ctx, "abc", 5)).toBe("…");
  });
});

describe("XRPanel editing", () => {
  beforeEach(() => {
    stubCanvas2D();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const head = new THREE.Vector3(0, 1.6, 0);
  const ahead = new THREE.Quaternion();

  it("resizes to the editing panel, floats lower, and hit-tests its buttons", () => {
    const panel = new XRPanel();
    panel.update(full, [], []);
    panel.follow(head, ahead, 0.016);
    expect(panel.editing).toBe(false);
    const dispose = vi.spyOn(panel.mesh.geometry, "dispose");
    panel.update(editState, [], []);
    expect(panel.editing).toBe(true);
    expect(dispose).toHaveBeenCalled();
    const size = panelSize(editState);
    panel.mesh.geometry.computeBoundingBox();
    const box = panel.mesh.geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(size.width, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(size.height, 6);
    // Switching panels puts it in front again, where the editing panel goes.
    panel.follow(head, ahead, 0.016);
    expect(panel.mesh.position.y).toBeCloseTo(1.6 - XR_EDIT_PANEL_PLACEMENT.drop, 9);
    expect(panel.mesh.position.z).toBeCloseTo(-XR_EDIT_PANEL_PLACEMENT.distance, 9);
    expect(panel.controls).toEqual([
      "edit:tool:select",
      "edit:tool:add",
      "edit:element:6",
      "edit:undo",
      "reset",
      "exit",
    ]);
    for (const id of ["edit:tool:add", "edit:undo", "exit"] as const) {
      const pose = panel.controlPose(id)!;
      const ray = new THREE.Ray(
        pose.position,
        new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion),
      );
      expect(panel.hit(ray)?.id).toBe(id);
      expect(panel.covers(ray)).toBeCloseTo(0.15, 6);
    }
    // The same size again keeps the canvas and the plane.
    const geometry = panel.mesh.geometry;
    panel.update({ ...editState, edit: { ...editing, title: "Bond" } }, [], []);
    expect(panel.mesh.geometry).toBe(geometry);
    // In the glide back, the editing panel follows its own placement.
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    for (let i = 0; i < 100; i++) panel.follow(head, turned, 0.1);
    expect(Math.abs(panel.mesh.position.x + XR_EDIT_PANEL_PLACEMENT.distance)).toBeLessThan(0.011);
  });
});
