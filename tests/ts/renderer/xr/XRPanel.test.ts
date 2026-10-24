import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as THREE from "three";
import {
  drawPanel,
  hitControl,
  layoutPanel,
  scrubFrame,
  XRPanel,
  XR_PANEL_HEIGHT,
  XR_PANEL_PX_HEIGHT,
  XR_PANEL_PX_WIDTH,
  XR_PANEL_WIDTH,
  type XRPanelRect,
  type XRPanelState,
} from "@/renderer/xr/XRPanel";
import { XR_PANEL_DISTANCE, XR_PANEL_DROP } from "@/renderer/xr/xrMath";
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
