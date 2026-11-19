import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  classifyScene,
  isImpostorMesh,
  isOpaqueSurface,
  lightCamera,
  litBoundingSphere,
  litMinAlong,
} from "@/renderer/studio/sceneSetup";

/** A stand-in for ImpostorAtomMesh: instanced centres + radii, a uPass uniform. */
function atoms(centers: number[][], radius = 1, scale = 1): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
  geo.setAttribute(
    "instanceCenter",
    new THREE.InstancedBufferAttribute(new Float32Array(centers.flat()), 3),
  );
  geo.setAttribute(
    "instanceRadius",
    new THREE.InstancedBufferAttribute(new Float32Array(centers.map(() => radius)), 1),
  );
  geo.instanceCount = centers.length;
  const mat = new THREE.RawShaderMaterial({
    uniforms: { uPass: { value: 0 }, uScaleMultiplier: { value: scale } },
  });
  return new THREE.Mesh(geo, mat);
}

/** A stand-in for ImpostorBondMesh: uPass, but no instance centres. */
function bonds(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.InstancedBufferGeometry(),
    new THREE.RawShaderMaterial({ uniforms: { uPass: { value: 0 } } }),
  );
}

function box(material: THREE.Material, at = new THREE.Vector3()): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  m.position.copy(at);
  return m;
}

describe("isImpostorMesh / isOpaqueSurface", () => {
  it("tells impostors, opaque surfaces and the rest apart", () => {
    expect(isImpostorMesh(atoms([[0, 0, 0]]))).toBe(true);
    expect(isImpostorMesh(box(new THREE.MeshBasicMaterial()))).toBe(false);
    expect(isImpostorMesh(new THREE.Line())).toBe(false);
    expect(
      isImpostorMesh(new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial()])),
    ).toBe(false);

    expect(isOpaqueSurface(box(new THREE.MeshStandardMaterial()))).toBe(true);
    expect(
      isOpaqueSurface(box(new THREE.MeshPhongMaterial({ transparent: true, opacity: 1 }))),
    ).toBe(true);
    expect(isOpaqueSurface(box(new THREE.MeshLambertMaterial()))).toBe(true);
    expect(isOpaqueSurface(box(new THREE.MeshToonMaterial()))).toBe(true);
    expect(
      isOpaqueSurface(box(new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.5 }))),
    ).toBe(false);
    expect(isOpaqueSurface(box(new THREE.MeshNormalMaterial()))).toBe(false);
    expect(isOpaqueSurface(box(new THREE.ShaderMaterial()))).toBe(false);
    expect(isOpaqueSurface(new THREE.Line())).toBe(false);
    expect(
      isOpaqueSurface(new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial()])),
    ).toBe(false);
  });
});

describe("classifyScene", () => {
  it("sorts visible drawables and keeps overlay roots out of the lit set", () => {
    const scene = new THREE.Scene();
    const a = atoms([[0, 0, 0]]);
    const b = bonds();
    const cartoon = box(new THREE.MeshStandardMaterial());
    const glass = box(new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.4 }));
    const cell = new THREE.LineSegments();
    const sprite = new THREE.Sprite();
    const selection = new THREE.Group();
    const highlight = box(new THREE.MeshBasicMaterial());
    selection.add(highlight);
    const hidden = new THREE.Group();
    hidden.visible = false;
    hidden.add(box(new THREE.MeshStandardMaterial()));
    scene.add(a, b, cartoon, glass, cell, sprite, selection, hidden, new THREE.Group());

    const s = classifyScene(scene, [selection]);
    expect(s.impostors).toEqual([a, b]);
    expect(s.surfaces).toEqual([cartoon]);
    expect(s.overlay).toEqual([glass, cell, sprite, highlight]);
  });

  it("treats everything as candidates when no overlay roots are given", () => {
    const scene = new THREE.Scene();
    const m = box(new THREE.MeshBasicMaterial());
    scene.add(m);
    expect(classifyScene(scene).surfaces).toEqual([m]);
  });
});

describe("litBoundingSphere", () => {
  it("encloses atom centres padded for their radius, and opaque surfaces", () => {
    const scene = new THREE.Scene();
    scene.add(
      atoms([
        [-10, 0, 0],
        [10, 0, 0],
      ]),
      bonds(),
      box(new THREE.MeshBasicMaterial(), new THREE.Vector3(0, 20, 0)),
    );
    const s = litBoundingSphere(classifyScene(scene))!;
    for (const p of [
      [-13, 0, 0],
      [13, 0, 0],
      [0, 21, 0],
    ]) {
      expect(s.containsPoint(new THREE.Vector3(...p))).toBe(true);
    }
  });

  it("follows the mesh transform and grows the margin with the atom scale", () => {
    const scene = new THREE.Scene();
    const a = atoms([[0, 0, 0]], 1, 2);
    a.position.set(5, 0, 0);
    scene.add(a);
    scene.updateMatrixWorld(true);
    const s = litBoundingSphere(classifyScene(scene))!;
    expect(s.center.x).toBeCloseTo(5);
    // 3 Å margin times scale 2, on each side of a point.
    expect(s.radius).toBeCloseTo(Math.sqrt(3) * 6);
  });

  it("is null for a scene with nothing lit", () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.LineSegments(), bonds(), atoms([]));
    expect(litBoundingSphere(classifyScene(scene))).toBeNull();
  });
});

describe("litMinAlong", () => {
  it("finds the lowest atom surface and surface corner along an axis", () => {
    const scene = new THREE.Scene();
    scene.add(
      atoms(
        [
          [0, 4, 0],
          [0, -2, 0],
        ],
        1.5,
        2,
      ),
      bonds(),
    );
    const studio = classifyScene(scene);
    const up = new THREE.Vector3(0, 1, 0);
    // centre -2 minus radius 1.5 * scale 2
    expect(litMinAlong(studio, up)).toBeCloseTo(-5);
    expect(litMinAlong(studio, up.clone().negate())).toBeCloseTo(-7);

    scene.add(box(new THREE.MeshBasicMaterial(), new THREE.Vector3(0, -10, 0)));
    expect(litMinAlong(classifyScene(scene), up)).toBeCloseTo(-11);
  });

  it("is null when nothing is lit, and skips empty surfaces", () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
    expect(litMinAlong(classifyScene(scene), new THREE.Vector3(0, 1, 0))).toBeNull();
  });

  it("treats atoms without a radius attribute as points", () => {
    const a = atoms([[0, 3, 0]]);
    a.geometry.deleteAttribute("instanceRadius");
    const scene = new THREE.Scene();
    scene.add(a);
    expect(litMinAlong(classifyScene(scene), new THREE.Vector3(0, 1, 0))).toBeCloseTo(3);
  });
});

describe("lightCamera", () => {
  it("frames the sphere from the light's side, looking at its centre", () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(1, 2, 3), 10);
    const cam = lightCamera(sphere, new THREE.Vector3(0, 0, 5));
    expect(cam.right - cam.left).toBeCloseTo(20);
    expect(cam.top - cam.bottom).toBeCloseTo(20);
    expect(cam.position.z).toBeGreaterThan(3 + 10);
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    expect(fwd.z).toBeCloseTo(-1);
    // The whole sphere fits between near and far.
    const dist = cam.position.distanceTo(sphere.center);
    expect(cam.near).toBeLessThanOrEqual(dist - 10);
    expect(cam.far).toBeGreaterThanOrEqual(dist + 10);
  });

  it("widens by `frame` and copes with a light straight overhead", () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(), 4);
    const target = new THREE.OrthographicCamera();
    const cam = lightCamera(sphere, new THREE.Vector3(0, 1, 0), target, 1.5);
    expect(cam).toBe(target);
    expect(cam.right).toBeCloseTo(6);
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    expect(fwd.y).toBeCloseTo(-1);
    expect(Number.isFinite(cam.matrixWorldInverse.elements[0])).toBe(true);
  });
});
