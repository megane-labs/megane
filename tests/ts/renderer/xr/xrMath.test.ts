import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  boundingFocus,
  clampXRScale,
  computeXRPlacement,
  depthCueRange,
  handMotion,
  movedPastSlop,
  rayPointNear,
  XR_CLICK_SLOP_ANGLE,
  XR_CLICK_SLOP_DISTANCE,
  XR_DEPTH_CUE_MAX_SPAN,
  XR_EDIT_PANEL_PLACEMENT,
  XR_PLACE_MIN_DISTANCE,
  XR_NEAR_FADE,
  modelScale,
  oneHandGrab,
  panelOutOfReach,
  panelPose,
  rayFromPose,
  rayHitsPanel,
  stickSteer,
  twoHandGrab,
  XR_MAX_SCALE,
  XR_MIN_SCALE,
  XR_PANEL_DISTANCE,
  XR_PANEL_DROP,
  XR_PANEL_FOLLOW_ANGLE,
  XR_PANEL_FOLLOW_DISTANCE,
  XR_PLACEMENT_DISTANCE,
  XR_PLACEMENT_DROP,
  XR_PLACEMENT_RADIUS,
  XR_STICK_TURN_RATE,
  XR_STICK_ZOOM_RATE,
} from "@/renderer/xr/xrMath";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function expectVec(actual: THREE.Vector3, expected: THREE.Vector3, digits = 6) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

/** A similarity transform with the given translation, rotation and scale. */
function similarity(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number) {
  return new THREE.Matrix4().compose(position, quaternion, v(scale, scale, scale));
}

describe("clampXRScale / modelScale", () => {
  it("clamps into the allowed range", () => {
    expect(clampXRScale(1e-9)).toBe(XR_MIN_SCALE);
    expect(clampXRScale(10)).toBe(XR_MAX_SCALE);
    expect(clampXRScale(0.01)).toBe(0.01);
  });

  it("reads the uniform scale of a rotated, translated model", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(v(1, 1, 0).normalize(), 0.7);
    expect(modelScale(similarity(v(3, -2, 1), q, 0.02))).toBeCloseTo(0.02, 9);
  });
});

describe("boundingFocus", () => {
  it("falls back to a 10 Å sphere at the origin for an empty structure", () => {
    const f = boundingFocus([], 0);
    expectVec(f.center, v(0, 0, 0));
    expect(f.radius).toBe(10);
  });

  it("centres on the bounding box and pads the half-diagonal", () => {
    const positions = [0, 0, 0, 6, 8, 0, 3, 4, 0];
    const f = boundingFocus(positions, 3, 1);
    expectVec(f.center, v(3, 4, 0));
    expect(f.radius).toBeCloseTo(5 + 1, 9);
  });

  it("only reads nAtoms positions", () => {
    const f = boundingFocus([1, 1, 1, 100, 100, 100], 1);
    expectVec(f.center, v(1, 1, 1));
    expect(f.radius).toBe(2);
  });
});

describe("computeXRPlacement", () => {
  const focus = { center: v(10, 20, 30), radius: 25 };
  const identity = new THREE.Quaternion();

  it("puts the centre at arm's length ahead, slightly below the eyes, scaled to fit", () => {
    const head = v(0.5, 1.6, 2);
    const model = computeXRPlacement(focus, head, identity, identity);
    expect(modelScale(model)).toBeCloseTo(XR_PLACEMENT_RADIUS / 25, 9);
    const center = focus.center.clone().applyMatrix4(model);
    expectVec(center, v(0.5, 1.6 - XR_PLACEMENT_DROP, 2 - XR_PLACEMENT_DISTANCE));
  });

  it("follows the head's yaw but ignores its pitch", () => {
    const head = v(0, 1.5, 0);
    // Turned 90° left (facing −x) and looking down 40°.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, Math.PI / 2, 0, "YXZ"));
    const center = focus.center.clone().applyMatrix4(computeXRPlacement(focus, head, q, identity));
    expectVec(center, v(-XR_PLACEMENT_DISTANCE, 1.5 - XR_PLACEMENT_DROP, 0));
  });

  it("keeps a sensible direction when the head looks straight down", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), -Math.PI / 2);
    const center = focus.center
      .clone()
      .applyMatrix4(computeXRPlacement(focus, v(0, 1, 0), q, identity));
    expectVec(center, v(0, 1 - XR_PLACEMENT_DROP, -XR_PLACEMENT_DISTANCE));
  });

  it("shows the side the desktop camera was looking at", () => {
    // Desktop camera looking down −x from +x: the +x face points at the viewer.
    const view = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), Math.PI / 2);
    const model = computeXRPlacement(focus, v(0, 1.6, 0), identity, view);
    const towardViewer = v(1, 0, 0).transformDirection(model);
    expectVec(towardViewer, v(0, 0, 1));
  });

  it("clamps the scale for degenerate and huge structures", () => {
    const tiny = computeXRPlacement(
      { center: v(0, 0, 0), radius: 0 },
      v(0, 0, 0),
      identity,
      identity,
    );
    expect(modelScale(tiny)).toBeCloseTo(XR_MAX_SCALE, 9);
    const huge = computeXRPlacement(
      { center: v(0, 0, 0), radius: 1e9 },
      v(0, 0, 0),
      identity,
      identity,
    );
    expect(modelScale(huge)).toBeCloseTo(XR_MIN_SCALE, 12);
  });
});

describe("oneHandGrab", () => {
  it("carries the model rigidly with the hand", () => {
    const startModel = similarity(v(0, 1, -1), new THREE.Quaternion(), 0.01);
    const startHand = new THREE.Matrix4().makeTranslation(0.2, 1, -0.5);
    const turn = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), Math.PI / 2);
    const hand = new THREE.Matrix4().compose(v(0.4, 1.2, -0.5), turn, v(1, 1, 1));
    const model = oneHandGrab(startHand, hand, startModel);
    expect(modelScale(model)).toBeCloseTo(0.01, 9);
    // The model origin sat at (−0.2, 0, −0.5) from the hand; after a 90° left
    // turn that offset is (−0.5, 0, 0.2), taken from the hand's new position.
    expectVec(v(0, 0, 0).applyMatrix4(model), v(0.4 - 0.5, 1.2, -0.5 + 0.2));
  });

  it("leaves the model alone while the hand has not moved", () => {
    const startModel = similarity(v(1, 2, 3), new THREE.Quaternion(), 0.05);
    const hand = new THREE.Matrix4().makeTranslation(0.1, 0.2, 0.3);
    expect(oneHandGrab(hand, hand.clone(), startModel).equals(startModel)).toBe(true);
  });
});

describe("twoHandGrab", () => {
  const startModel = similarity(v(0, 1, -1), new THREE.Quaternion(), 0.01);
  const a0 = v(-0.1, 1, -0.5);
  const b0 = v(0.1, 1, -0.5);

  it("scales by the change in hand spacing about the hands' midpoint", () => {
    const model = twoHandGrab(a0, b0, v(-0.2, 1, -0.5), v(0.2, 1, -0.5), startModel);
    expect(modelScale(model)).toBeCloseTo(0.02, 9);
    // A point at the midpoint stays put.
    const mid = v(0, 1, -0.5);
    const local = mid.clone().applyMatrix4(startModel.clone().invert());
    expectVec(local.applyMatrix4(model), mid);
  });

  it("turns with the line between the hands and follows their midpoint", () => {
    // Swing the right hand to the front: a 90° turn about +y, midpoint moves.
    const a = v(0, 1, -0.4);
    const b = v(0, 1, -0.6);
    const model = twoHandGrab(a0, b0, a, b, startModel);
    expect(modelScale(model)).toBeCloseTo(0.01, 9);
    const xAxis = v(1, 0, 0).transformDirection(model);
    expectVec(xAxis, v(0, 0, -1));
    const startMidLocal = v(0, 1, -0.5).applyMatrix4(startModel.clone().invert());
    expectVec(startMidLocal.applyMatrix4(model), v(0, 1, -0.5));
  });

  it("respects the scale bounds", () => {
    const model = twoHandGrab(a0, b0, v(-100, 1, -0.5), v(100, 1, -0.5), startModel);
    expect(modelScale(model)).toBeCloseTo(XR_MAX_SCALE, 9);
  });

  it("ignores coincident hands", () => {
    const model = twoHandGrab(a0, a0.clone(), a0, b0, startModel);
    expect(model.equals(startModel)).toBe(true);
    expect(model).not.toBe(startModel);
  });
});

describe("stickSteer", () => {
  const model = similarity(v(0, 1, -1), new THREE.Quaternion(), 0.01);
  const pivot = v(0, 1, -1);

  it("ignores deflection inside the deadzone", () => {
    const out = stickSteer(model, pivot, 0.1, -0.1, 0.5);
    expect(out.equals(model)).toBe(true);
    expect(out).not.toBe(model);
  });

  it("zooms in when pushed forward, out when pulled back, about the pivot", () => {
    const zoomIn = stickSteer(model, pivot, 0, -1, 0.1);
    expect(modelScale(zoomIn)).toBeCloseTo(0.01 * Math.exp(XR_STICK_ZOOM_RATE * 0.1), 9);
    expectVec(v(0, 0, 0).applyMatrix4(zoomIn), pivot);
    const zoomOut = stickSteer(model, pivot, 0, 1, 0.1);
    expect(modelScale(zoomOut)).toBeLessThan(0.01);
  });

  it("turns about the vertical axis through the pivot", () => {
    const turned = stickSteer(model, pivot, 1, 0, 0.2);
    const xAxis = v(1, 0, 0).transformDirection(turned);
    const angle = -XR_STICK_TURN_RATE * 0.2;
    expectVec(xAxis, v(Math.cos(angle), 0, -Math.sin(angle)));
    expectVec(v(0, 0, 0).applyMatrix4(turned), pivot);
  });
});

describe("depthCueRange", () => {
  it("spans the structure from its near side to its far side", () => {
    const r = depthCueRange(v(0, 1.6, 0), v(0, 1.6, -1.1), 0.4);
    expect(r.start).toBeCloseTo(0.7, 9);
    expect(r.end).toBeCloseTo(1.5, 9);
  });

  it("never starts nearer than the near fade", () => {
    const r = depthCueRange(v(0, 0, 0), v(0, 0, -0.5), 0.4);
    expect(r.start).toBe(XR_NEAR_FADE);
    expect(r.end).toBeCloseTo(0.9, 9);
  });

  it("caps the ramp from inside a large model so nearby atoms stay crisp", () => {
    const r = depthCueRange(v(0, 0, 0), v(0, 0, -1), 10);
    expect(r.start).toBe(XR_NEAR_FADE);
    expect(r.end).toBeCloseTo(XR_NEAR_FADE + XR_DEPTH_CUE_MAX_SPAN, 9);
    // A small model you are inside ends at its far side.
    const small = depthCueRange(v(0, 0, 0), v(0, 0, -0.1), 0.6);
    expect(small.end).toBeCloseTo(0.7, 9);
  });

  it("keeps a usable ramp for a vanishing model", () => {
    const r = depthCueRange(v(0, 0, 0), v(0, 0, -2), 0);
    expect(r.end - r.start).toBeCloseTo(0.05, 9);
  });
});

describe("panelPose", () => {
  it("floats ahead and below the eyes, facing them, ignoring head pitch", () => {
    const head = v(0.2, 1.6, 0.1);
    // Looking down 30°: the panel still sits level ahead.
    const pitched = new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), -Math.PI / 6);
    const { position, quaternion } = panelPose(head, pitched);
    expectVec(position, v(0.2, 1.6 - XR_PANEL_DROP, 0.1 - XR_PANEL_DISTANCE));
    // Its face (+z) points at the eyes.
    const normal = v(0, 0, 1).applyQuaternion(quaternion);
    expectVec(normal, head.clone().sub(position).normalize());
  });

  it("follows the head's yaw", () => {
    const yaw = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), Math.PI / 2);
    const { position } = panelPose(v(0, 1.6, 0), yaw);
    // Turned left 90°: −z becomes −x.
    expectVec(position, v(-XR_PANEL_DISTANCE, 1.6 - XR_PANEL_DROP, 0));
  });

  it("falls back to −z when the head looks straight down", () => {
    const down = new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), -Math.PI / 2);
    const { position } = panelPose(v(0, 1.6, 0), down);
    expect(position.z).toBeCloseTo(-XR_PANEL_DISTANCE, 6);
  });
});

describe("panelOutOfReach", () => {
  const head = v(0, 1.6, 0);
  const ahead = new THREE.Quaternion();

  it("stays put inside the comfort zone", () => {
    const { position } = panelPose(head, ahead);
    expect(panelOutOfReach(position, head, ahead)).toBe(false);
    // A glance 20° to the side does not move it.
    const glance = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), (20 * Math.PI) / 180);
    expect(panelOutOfReach(position, head, glance)).toBe(false);
  });

  it("follows once the head turns well away", () => {
    const { position } = panelPose(head, ahead);
    const turned = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), XR_PANEL_FOLLOW_ANGLE + 0.3);
    expect(panelOutOfReach(position, head, turned)).toBe(true);
  });

  it("follows once the user walks away from it", () => {
    const { position } = panelPose(head, ahead);
    const walked = v(0, 1.6, XR_PANEL_FOLLOW_DISTANCE + 0.1);
    expect(panelOutOfReach(position, walked, ahead)).toBe(true);
  });

  it("follows when the panel is right above or below the head", () => {
    const position = v(0, 1.25, 0);
    expect(panelOutOfReach(position, head, ahead)).toBe(true);
  });
});

describe("rayFromPose", () => {
  it("points along the pose's −z axis from its origin", () => {
    const pose = new THREE.Matrix4().compose(
      v(1, 2, 3),
      new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), Math.PI / 2),
      v(1, 1, 1),
    );
    const ray = rayFromPose(pose);
    expectVec(ray.origin, v(1, 2, 3));
    expectVec(ray.direction, v(-1, 0, 0));
  });
});

describe("rayHitsPanel", () => {
  const panel = new THREE.Matrix4().makeTranslation(0, 1, -1);
  const ray = (origin: THREE.Vector3, dir: THREE.Vector3) =>
    new THREE.Ray(origin, dir.clone().normalize());

  it("maps the hit to panel coordinates from the top left", () => {
    const hit = rayHitsPanel(ray(v(0, 1, 0), v(0, 0, -1)), panel, 0.4, 0.2)!;
    expect(hit.u).toBeCloseTo(0.5, 9);
    expect(hit.v).toBeCloseTo(0.5, 9);
    expect(hit.distance).toBeCloseTo(1, 9);
    const corner = rayHitsPanel(ray(v(-0.15, 1.05, 0), v(0, 0, -1)), panel, 0.4, 0.2)!;
    expect(corner.u).toBeCloseTo(0.125, 9);
    expect(corner.v).toBeCloseTo(0.25, 9);
  });

  it("misses past the edges, from behind, and pointing away", () => {
    expect(rayHitsPanel(ray(v(0.3, 1, 0), v(0, 0, -1)), panel, 0.4, 0.2)).toBeNull();
    expect(rayHitsPanel(ray(v(0, 1, -2), v(0, 0, 1)), panel, 0.4, 0.2)).toBeNull();
    expect(rayHitsPanel(ray(v(0, 1, 0), v(0, 0, 1)), panel, 0.4, 0.2)).toBeNull();
    expect(rayHitsPanel(ray(v(0, 1, 0), v(1, 0, 0)), panel, 0.4, 0.2)).toBeNull();
  });

  it("keeps answering past the edges when unbounded", () => {
    const hit = rayHitsPanel(ray(v(0.3, 1, 0), v(0, 0, -1)), panel, 0.4, 0.2, false)!;
    expect(hit.u).toBeCloseTo(1.25, 9);
  });
});

describe("panel placement", () => {
  it("puts the editing panel further and lower than the viewer's", () => {
    const head = v(0, 1.6, 0);
    const q = new THREE.Quaternion();
    const { position } = panelPose(head, q, XR_EDIT_PANEL_PLACEMENT);
    expectVec(
      position,
      v(0, 1.6 - XR_EDIT_PANEL_PLACEMENT.drop, -XR_EDIT_PANEL_PLACEMENT.distance),
    );
    // In reach where it belongs, out of reach where the viewer's would be.
    expect(panelOutOfReach(position, head, q, XR_EDIT_PANEL_PLACEMENT)).toBe(false);
    expect(panelOutOfReach(v(0, 1.6, -2), head, q, XR_EDIT_PANEL_PLACEMENT)).toBe(true);
  });
});

describe("movedPastSlop", () => {
  const start = new THREE.Matrix4().makeTranslation(0, 1.2, -0.3);

  it("lets a hand that barely moved count as a click", () => {
    const now = start.clone().setPosition(0.005, 1.2, -0.3);
    expect(movedPastSlop(start, now)).toBe(false);
    const turned = new THREE.Matrix4()
      .makeRotationY(XR_CLICK_SLOP_ANGLE * 0.5)
      .setPosition(0, 1.2, -0.3);
    expect(movedPastSlop(start, turned)).toBe(false);
  });

  it("calls it a drag once the hand moves or turns past the slop", () => {
    const now = start.clone().setPosition(XR_CLICK_SLOP_DISTANCE * 1.5, 1.2, -0.3);
    expect(movedPastSlop(start, now)).toBe(true);
    const turned = new THREE.Matrix4()
      .makeRotationX(XR_CLICK_SLOP_ANGLE * 2)
      .setPosition(0, 1.2, -0.3);
    expect(movedPastSlop(start, turned)).toBe(true);
  });
});

describe("rayPointNear", () => {
  it("is the ray's point nearest the target", () => {
    const ray = new THREE.Ray(v(0, 0, 0), v(0, 0, -1));
    expectVec(rayPointNear(ray, v(0.3, 0.1, -1)), v(0, 0, -1));
  });

  it("never comes nearer the hand than the minimum", () => {
    const ray = new THREE.Ray(v(0, 0, 0), v(0, 0, -1));
    expectVec(rayPointNear(ray, v(0, 0, 0.5)), v(0, 0, -XR_PLACE_MIN_DISTANCE));
    expectVec(rayPointNear(ray, v(0, 0, -0.05), 0.2), v(0, 0, -0.2));
  });
});

describe("handMotion", () => {
  const model = similarity(v(0, 1, -1), new THREE.Quaternion(), 0.01);
  const pivot = v(10, 0, 0);

  it("carries the atoms with the hand, metres to Å", () => {
    const start = new THREE.Matrix4().makeTranslation(0.1, 1.2, -0.4);
    const hand = new THREE.Matrix4().makeTranslation(0.15, 1.2, -0.4);
    const m = handMotion(start, hand, model, model, pivot);
    expectVec(m.translation, v(5, 0, 0));
    expect(m.rotation.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9);
    expectVec(m.pivot, pivot);
    // The pivot is copied: the caller's vector stays its own.
    expect(m.pivot).not.toBe(pivot);
  });

  it("turns them about the pivot as the wrist turns, swinging the pivot on the ray", () => {
    // The hand sits right at the pivot (0.1, 1, -1 in the room) and turns 90° about +y.
    const at = v(10, 0, 0).applyMatrix4(model);
    const start = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z);
    const hand = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(at);
    const m = handMotion(start, hand, model, model, pivot);
    expectVec(m.translation, v(0, 0, 0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(m.rotation.w)));
    expect(angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it("follows the structure when the other hand carries or zooms it meanwhile", () => {
    const start = new THREE.Matrix4().makeTranslation(0.1, 1.2, -0.4);
    // The hand stays still; the structure moves 10 cm left and doubles in size.
    const moved = similarity(v(-0.1, 1, -1), new THREE.Quaternion(), 0.02);
    const m = handMotion(start, start, model, moved, pivot);
    // The atom stays where the hand holds it in the room.
    const room = pivot.clone().add(m.translation).applyMatrix4(moved);
    expectVec(room, pivot.clone().applyMatrix4(model));
  });
});
