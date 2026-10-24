import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as THREE from "three";
import {
  nearestLabelled,
  XRAtomLabels,
  XRMeasureLabel,
  XR_LABEL_HEIGHT,
  XR_LABEL_REFRESH,
  XR_MAX_LABELS,
  XR_MEASURE_LABEL_HEIGHT,
  type XRLabelSource,
} from "@/renderer/xr/xrLabels";
import { stubCanvas2D, type FakeContext2D } from "./fakeCanvas";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const FORWARD = v(0, 0, -1);

/** `n` atoms in a row along −z from the origin, 1 Å apart, labelled A0, A1, … */
function row(n: number, label = (i: number) => `A${i}`): XRLabelSource {
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3 + 2] = -(i + 1);
  return { labels: Array.from({ length: n }, (_, i) => label(i)), positions, count: n };
}

describe("nearestLabelled", () => {
  it("picks the nearest labelled atoms in front of the head, nearest first", () => {
    const source = row(6, (i) => (i === 1 ? "" : `A${i}`));
    expect(nearestLabelled(source, v(0, 0, 0), FORWARD, 3)).toEqual([0, 2, 3]);
    // From the far end looking back.
    expect(nearestLabelled(source, v(0, 0, -7), v(0, 0, 1), 2)).toEqual([5, 4]);
    // Nothing is in front when looking away.
    expect(nearestLabelled(source, v(0, 0, 0), v(0, 0, 1), 3)).toEqual([]);
  });

  it("keeps the nearest when atoms arrive out of order", () => {
    const source: XRLabelSource = {
      labels: ["far", "near", "mid", "nearer"],
      positions: [0, 0, -9, 0, 0, -2, 0, 0, -5, 0, 0, -1],
      count: 4,
    };
    expect(nearestLabelled(source, v(0, 0, 0), FORWARD, 2)).toEqual([3, 1]);
    expect(nearestLabelled(source, v(0, 0, 0), FORWARD, 10)).toEqual([3, 1, 2, 0]);
  });
});

describe("XRAtomLabels", () => {
  let contexts: FakeContext2D[];
  beforeEach(() => {
    contexts = stubCanvas2D();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const visible = (labels: XRAtomLabels) =>
    labels.group.children.filter((c) => c.visible) as THREE.Sprite[];

  it("puts a sprite on each nearby labelled atom, sized in metres", () => {
    const labels = new XRAtomLabels();
    const source = row(3);
    labels.update(source, v(0, 0, 0), FORWARD, 0.01, 0);
    expect(labels.count).toBe(3);
    const sprites = visible(labels);
    expect(sprites).toHaveLength(3);
    expect(sprites[0].position.toArray()).toEqual([0, 0, -1]);
    // 1.4 cm tall at 0.01 m/Å = 1.4 Å.
    expect(sprites[0].scale.y).toBeCloseTo(XR_LABEL_HEIGHT / 0.01, 9);
    expect(contexts.flatMap((c) => c.texts)).toEqual(expect.arrayContaining(["A0", "A1", "A2"]));
  });

  it("caps the count and re-chooses a few times a second", () => {
    const labels = new XRAtomLabels();
    const source = row(XR_MAX_LABELS + 10);
    labels.update(source, v(0, 0, 0), FORWARD, 0.01, 0);
    expect(labels.count).toBe(XR_MAX_LABELS);
    expect(visible(labels)[0].position.z).toBe(-1);
    // The head moves to the far end: nothing changes until the refresh is due…
    labels.update(source, v(0, 0, -(XR_MAX_LABELS + 11)), FORWARD.clone().negate(), 0.01, 0.01);
    expect(visible(labels)[0].position.z).toBe(-1);
    // …then the labels follow.
    labels.update(
      source,
      v(0, 0, -(XR_MAX_LABELS + 11)),
      FORWARD.clone().negate(),
      0.01,
      XR_LABEL_REFRESH,
    );
    expect(visible(labels)[0].position.z).toBe(-(XR_MAX_LABELS + 10));
  });

  it("re-chooses at once for a new label set and follows moving atoms", () => {
    const labels = new XRAtomLabels();
    const source = row(2);
    labels.update(source, v(0, 0, 0), FORWARD, 0.01, 0);
    const moved = { ...source, positions: new Float32Array([1, 0, -1, 1, 0, -2]) };
    labels.update(moved, v(0, 0, 0), FORWARD, 0.01, 0.01);
    expect(visible(labels)[0].position.x).toBe(1);
    labels.update(
      row(1, () => "B"),
      v(0, 0, 0),
      FORWARD,
      0.01,
      0.01,
    );
    expect(labels.count).toBe(1);
    expect(visible(labels)).toHaveLength(1);
  });

  it("shares one texture per string and hides everything without labels", () => {
    const labels = new XRAtomLabels();
    labels.update(
      row(3, () => "C"),
      v(0, 0, 0),
      FORWARD,
      0.01,
      0,
    );
    const maps = new Set(visible(labels).map((s) => s.material.map));
    expect(maps.size).toBe(1);
    labels.update(null, v(0, 0, 0), FORWARD, 0.01, 0);
    expect(labels.count).toBe(0);
    expect(visible(labels)).toHaveLength(0);
  });

  it("starts the texture cache over once it grows too large", () => {
    const labels = new XRAtomLabels();
    const big = row(600, (i) => `L${i}`);
    // Walk the head along the row so ever new strings get drawn.
    for (let start = 0; start < 600; start += XR_MAX_LABELS) {
      labels.update(big, v(0, 0, -start), FORWARD, 0.01, XR_LABEL_REFRESH);
    }
    const textures = (labels as unknown as { textures: Map<string, unknown> }).textures;
    expect(textures.size).toBeLessThanOrEqual(512 + XR_MAX_LABELS);
    labels.dispose();
    expect(textures.size).toBe(0);
    expect(labels.group.children).toHaveLength(0);
  });
});

describe("XRMeasureLabel", () => {
  beforeEach(() => {
    stubCanvas2D();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("floats the readout at a point, redrawing only when the text changes", () => {
    const label = new XRMeasureLabel();
    label.update("1.000 Å", v(1, 2, 3), 0.02);
    expect(label.sprite.visible).toBe(true);
    expect(label.sprite.position.toArray()).toEqual([1, 2, 3]);
    expect(label.sprite.scale.y).toBeCloseTo(XR_MEASURE_LABEL_HEIGHT / 0.02, 9);
    const map = label.sprite.material.map;
    label.update("1.000 Å", v(0, 0, 0), 0.01);
    expect(label.sprite.material.map).toBe(map);
    expect(label.sprite.scale.y).toBeCloseTo(XR_MEASURE_LABEL_HEIGHT / 0.01, 9);
    label.update("109.5°", v(0, 0, 0), 0.01);
    expect(label.sprite.material.map).not.toBe(map);
    label.update(null, v(0, 0, 0), 0.01);
    expect(label.sprite.visible).toBe(false);
    label.update("2", null, 0.01);
    expect(label.sprite.visible).toBe(false);
    label.dispose();
  });
});
