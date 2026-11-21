/**
 * Scene preparation for the publication (studio) renderer: which objects the
 * studio lights itself, which are drawn over its picture unchanged, how far
 * the lit part of the scene reaches, and the camera each light looks through.
 */

import * as THREE from "three";

/** A mesh drawn by the impostor shaders (atoms, bonds): it has the `uPass` switch. */
export function isImpostorMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh || Array.isArray(mesh.material)) return false;
  const mat = mesh.material as THREE.ShaderMaterial;
  return mat.uniforms?.uPass !== undefined;
}

type LitMaterial =
  | THREE.MeshStandardMaterial
  | THREE.MeshPhongMaterial
  | THREE.MeshLambertMaterial
  | THREE.MeshBasicMaterial
  | THREE.MeshToonMaterial;

function isLitSurfaceMaterial(m: THREE.Material): m is LitMaterial {
  const t = m as LitMaterial & Record<string, unknown>;
  return Boolean(
    t.isMeshStandardMaterial ||
    t.isMeshPhongMaterial ||
    t.isMeshLambertMaterial ||
    t.isMeshBasicMaterial ||
    t.isMeshToonMaterial,
  );
}

/** Opaque enough to take part in the G-buffer: it hides what is behind it. */
export function isOpaqueSurface(obj: THREE.Object3D): obj is THREE.Mesh {
  const mat = litSurfaceMaterial(obj);
  return mat !== null && mat.opacity >= 0.999;
}

/**
 * A see-through lit mesh (coordination polyhedra, a translucent surface): the
 * studio lights it too, blended over each sample. Nearly invisible ones are
 * left alone.
 */
export function isTranslucentSurface(obj: THREE.Object3D): obj is THREE.Mesh {
  const mat = litSurfaceMaterial(obj);
  return mat !== null && mat.opacity < 0.999 && mat.opacity > 0.01;
}

function litSurfaceMaterial(obj: THREE.Object3D): LitMaterial | null {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh || Array.isArray(mesh.material)) return null;
  const mat = mesh.material as THREE.Material;
  if (!isLitSurfaceMaterial(mat) || mat.visible === false) return null;
  return mat;
}

export interface StudioScene {
  /** Atom / bond impostors: lit by the studio, translucent fragments drawn over it. */
  impostors: THREE.Mesh[];
  /** Opaque meshes (cartoon, opaque surfaces and polyhedra): lit by the studio. */
  surfaces: THREE.Mesh[];
  /** Translucent meshes (polyhedra, see-through surfaces): lit and blended per sample. */
  translucent: THREE.Mesh[];
  /**
   * Everything else that draws (lines, sprites, nearly invisible meshes, the
   * selection overlay): hidden while the studio renders, then drawn over the
   * finished picture with its own material.
   */
  overlay: THREE.Object3D[];
}

function isDrawable(obj: THREE.Object3D): boolean {
  const o = obj as THREE.Object3D & Record<string, boolean | undefined>;
  return Boolean(o.isMesh || o.isLine || o.isPoints || o.isSprite);
}

function hasAncestorIn(obj: THREE.Object3D, roots: ReadonlySet<THREE.Object3D>): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    if (roots.has(o)) return true;
  }
  return false;
}

/**
 * Sort every visible drawable in `scene`. Objects under `overlayRoots` (e.g.
 * the selection highlight) always stay overlay, so they are never shaded or
 * allowed to cast shadows.
 */
export function classifyScene(
  scene: THREE.Object3D,
  overlayRoots: Iterable<THREE.Object3D> = [],
): StudioScene {
  const roots = new Set(overlayRoots);
  const result: StudioScene = { impostors: [], surfaces: [], translucent: [], overlay: [] };
  scene.traverseVisible((obj) => {
    if (!isDrawable(obj)) return;
    if (roots.size > 0 && hasAncestorIn(obj, roots)) {
      result.overlay.push(obj);
    } else if (isImpostorMesh(obj)) {
      result.impostors.push(obj);
    } else if (isOpaqueSurface(obj)) {
      result.surfaces.push(obj);
    } else if (isTranslucentSurface(obj)) {
      result.translucent.push(obj);
    } else {
      result.overlay.push(obj);
    }
  });
  return result;
}

/** Margin added around atom centres for the largest atom radius, in Å. */
const ATOM_MARGIN = 3;

/**
 * A sphere enclosing everything the studio lights: every impostor instance
 * centre (padded by the largest atom radius) and every opaque surface. The
 * shadow cameras are fitted to it. `null` when nothing is lit.
 */
export function litBoundingSphere(studio: StudioScene): THREE.Sphere | null {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const mesh of studio.impostors) {
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    const centers = geo.getAttribute("instanceCenter") as THREE.BufferAttribute | undefined;
    if (!centers) continue; // bonds: their ends are atom centres
    const count = Math.min(geo.instanceCount ?? centers.count, centers.count);
    const mat = mesh.material as THREE.ShaderMaterial;
    const scale = (mat.uniforms.uScaleMultiplier?.value as number | undefined) ?? 1;
    const margin = ATOM_MARGIN * Math.max(1, scale);
    mesh.updateWorldMatrix(true, false);
    const local = new THREE.Box3();
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(centers, i);
      local.expandByPoint(p);
    }
    if (local.isEmpty()) continue;
    local.expandByScalar(margin);
    box.union(local.applyMatrix4(mesh.matrixWorld));
  }
  for (const mesh of [...studio.surfaces, ...studio.translucent]) {
    box.union(new THREE.Box3().setFromObject(mesh));
  }
  if (box.isEmpty()) return null;
  return box.getBoundingSphere(new THREE.Sphere());
}

/**
 * The lowest point of the lit scene along world-space unit vector `axis`:
 * min over atoms of (centre · axis − radius), and over the corners of every
 * opaque surface's bounding box. The ground shadow's plane rests there.
 */
export function litMinAlong(studio: StudioScene, axis: THREE.Vector3): number | null {
  let min = Infinity;
  const p = new THREE.Vector3();
  for (const mesh of studio.impostors) {
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    const centers = geo.getAttribute("instanceCenter") as THREE.BufferAttribute | undefined;
    if (!centers) continue;
    const radii = geo.getAttribute("instanceRadius") as THREE.BufferAttribute | undefined;
    const count = Math.min(geo.instanceCount ?? centers.count, centers.count);
    const mat = mesh.material as THREE.ShaderMaterial;
    const scale = (mat.uniforms.uScaleMultiplier?.value as number | undefined) ?? 1;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(centers, i).applyMatrix4(mesh.matrixWorld);
      const r = radii ? radii.getX(i) * scale : 0;
      min = Math.min(min, p.dot(axis) - r);
    }
  }
  for (const mesh of [...studio.surfaces, ...studio.translucent]) {
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) continue;
    for (let k = 0; k < 8; k++) {
      p.set(
        k & 1 ? box.max.x : box.min.x,
        k & 2 ? box.max.y : box.min.y,
        k & 4 ? box.max.z : box.min.z,
      );
      min = Math.min(min, p.dot(axis));
    }
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * An orthographic camera looking at `sphere` from world-space direction
 * `toLight` (pointing at the light), framing it exactly — or `frame` times
 * wider, so a shadow cast onto the ground beside the scene stays in the map —
 * so the light's shadow map spends its resolution on the lit scene.
 */
export function lightCamera(
  sphere: THREE.Sphere,
  toLight: THREE.Vector3,
  target: THREE.OrthographicCamera = new THREE.OrthographicCamera(),
  frame = 1,
): THREE.OrthographicCamera {
  const r = Math.max(sphere.radius, 1e-3);
  const half = r * frame;
  const dir = toLight.clone().normalize();
  target.left = -half;
  target.right = half;
  target.top = half;
  target.bottom = -half;
  target.near = 0;
  target.far = 2 * r * 1.02 + 1;
  target.position.copy(sphere.center).addScaledVector(dir, r * 1.01 + 0.5);
  target.up.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.99) target.up.set(1, 0, 0);
  target.lookAt(sphere.center);
  target.updateMatrixWorld(true);
  target.updateProjectionMatrix();
  return target;
}
