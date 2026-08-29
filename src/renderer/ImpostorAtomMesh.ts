/**
 * Billboard impostor sphere renderer.
 *
 * Instead of rendering N SphereGeometries (32+ triangles each),
 * each atom is a single screen-aligned quad (2 triangles) with a
 * fragment shader that ray-traces a perfect sphere with correct depth.
 *
 * Memory: 7 floats/atom (x,y,z, r, cr,cg,cb) vs 100s of vertices.
 * Draw calls: 1 (single instanced draw).
 * Scales to 1M+ atoms on mid-range GPUs.
 */

import * as THREE from "three";
import type { Snapshot } from "../types";
import {
  getColor,
  getRadius,
  BALL_STICK_ATOM_SCALE,
  ILLUSTRATIVE_AMBIENT_DARKENING,
  ILLUSTRATIVE_OUTLINE_COLOR,
  ILLUSTRATIVE_OUTLINE_WIDTH,
} from "../constants";
import { atomVertexShader, atomFragmentShader } from "./shaders";
import { type ColorContext, getAtomColorForScheme } from "../colorSchemes";

export class ImpostorAtomMesh {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private material: THREE.RawShaderMaterial;

  private centerAttr: THREE.InstancedBufferAttribute;
  private radiusAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private scaleOverrideAttr: THREE.InstancedBufferAttribute;
  private opacityOverrideAttr: THREE.InstancedBufferAttribute;

  private centerBuf: Float32Array;
  private radiusBuf: Float32Array;
  private colorBuf: Float32Array;
  private scaleOverrideBuf: Float32Array;
  private opacityOverrideBuf: Float32Array;
  /** Raw per-atom scale overrides before the hidden mask is composited in. */
  private rawScaleBuf: Float32Array;
  /** Per-atom hide flags (1 = hidden); composited into the scale override. */
  private hiddenBuf: Uint8Array;
  private nAtoms = 0;
  private capacity: number;
  // When non-null, every atom renders at this fixed radius (licorice mode);
  // when null, radii fall back to per-element vdW * `radiusScale`.
  private uniformRadius: number | null = null;
  // Fraction of the van der Waals radius each atom is drawn at when no uniform
  // radius is set: BALL_STICK_ATOM_SCALE for ball-and-stick, 1.0 (spacefill)
  // for the illustrative representation.
  private radiusScale = BALL_STICK_ATOM_SCALE;
  /**
   * Notified whenever the balls change size. The bond impostor subscribes so it
   * can trim each stick at the ball's surface; see `getBaseRadii` /
   * `getRadiusScale`. `radii` is null when only the global scalars moved, which
   * keeps the O(1) uniform updates O(1) on the bond side too.
   */
  private radiusSink: ((radii: Float32Array | null, scale: number) => void) | null = null;
  private baseRadiusBuf: Float32Array = new Float32Array(0);

  constructor(maxAtoms: number = 1_000_000) {
    this.capacity = maxAtoms;

    // Billboard quad: 2 triangles, [-1,1] in XY
    this.geo = new THREE.InstancedBufferGeometry();
    const verts = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geo.instanceCount = 0;

    // Instance buffers (pre-allocated for maxAtoms)
    this.centerBuf = new Float32Array(maxAtoms * 3);
    this.radiusBuf = new Float32Array(maxAtoms);
    this.colorBuf = new Float32Array(maxAtoms * 3);
    this.scaleOverrideBuf = new Float32Array(maxAtoms).fill(1.0);
    this.opacityOverrideBuf = new Float32Array(maxAtoms).fill(1.0);
    this.rawScaleBuf = new Float32Array(maxAtoms).fill(1.0);
    this.hiddenBuf = new Uint8Array(maxAtoms);

    this.centerAttr = new THREE.InstancedBufferAttribute(this.centerBuf, 3);
    this.radiusAttr = new THREE.InstancedBufferAttribute(this.radiusBuf, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorBuf, 3);
    this.scaleOverrideAttr = new THREE.InstancedBufferAttribute(this.scaleOverrideBuf, 1);
    this.opacityOverrideAttr = new THREE.InstancedBufferAttribute(this.opacityOverrideBuf, 1);

    this.centerAttr.setUsage(THREE.DynamicDrawUsage);
    this.radiusAttr.setUsage(THREE.StaticDrawUsage);
    this.colorAttr.setUsage(THREE.StaticDrawUsage);
    this.scaleOverrideAttr.setUsage(THREE.DynamicDrawUsage);
    this.opacityOverrideAttr.setUsage(THREE.DynamicDrawUsage);

    this.geo.setAttribute("instanceCenter", this.centerAttr);
    this.geo.setAttribute("instanceRadius", this.radiusAttr);
    this.geo.setAttribute("instanceColor", this.colorAttr);
    this.geo.setAttribute("instanceScaleOverride", this.scaleOverrideAttr);
    this.geo.setAttribute("instanceOpacityOverride", this.opacityOverrideAttr);

    // Custom shader material with uniforms for scale and opacity
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: atomVertexShader,
      fragmentShader: atomFragmentShader,
      uniforms: {
        uScaleMultiplier: { value: 1.0 },
        uOpacity: { value: 1.0 },
        uUsePerAtomOverrides: { value: 0 },
        uIllustrative: { value: 0 },
        uOutlineWidth: { value: ILLUSTRATIVE_OUTLINE_WIDTH },
        uOutlineColor: { value: new THREE.Vector3(...ILLUSTRATIVE_OUTLINE_COLOR) },
        uAmbientDarkening: { value: ILLUSTRATIVE_AMBIENT_DARKENING },
      },
      depthWrite: true,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
  }

  loadSnapshot(snapshot: Snapshot, colorCtx?: ColorContext): void {
    const { nAtoms, positions, elements } = snapshot;
    this.nAtoms = nAtoms;

    // Grow buffers if needed
    if (nAtoms > this.capacity) {
      this.grow(nAtoms);
    }

    // Fill buffers directly (no object allocation)
    for (let i = 0; i < nAtoms; i++) {
      const i3 = i * 3;
      this.centerBuf[i3] = positions[i3];
      this.centerBuf[i3 + 1] = positions[i3 + 1];
      this.centerBuf[i3 + 2] = positions[i3 + 2];

      this.radiusBuf[i] = this.uniformRadius ?? getRadius(elements[i]) * this.radiusScale;

      const [r, g, b] = colorCtx
        ? getAtomColorForScheme(i, snapshot, colorCtx)
        : getColor(elements[i]);
      this.colorBuf[i3] = r;
      this.colorBuf[i3 + 1] = g;
      this.colorBuf[i3 + 2] = b;
    }

    // Reset overrides on new snapshot
    this.scaleOverrideBuf.fill(1.0, 0, nAtoms);
    this.opacityOverrideBuf.fill(1.0, 0, nAtoms);
    this.rawScaleBuf.fill(1.0, 0, nAtoms);
    this.hiddenBuf.fill(0, 0, nAtoms);

    this.centerAttr.needsUpdate = true;
    this.radiusAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.scaleOverrideAttr.needsUpdate = true;
    this.opacityOverrideAttr.needsUpdate = true;
    this.geo.instanceCount = nAtoms;
    this.publishRadii(true);
  }

  updatePositions(positions: Float32Array): void {
    // Direct memcpy - no Matrix4 or Vector3 allocation
    this.centerBuf.set(positions.subarray(0, this.nAtoms * 3));
    this.centerAttr.needsUpdate = true;
  }

  /** Update atom radius scale (O(1) via shader uniform). */
  setScale(_scale: number, _snapshot: Snapshot): void {
    this.material.uniforms.uScaleMultiplier.value = _scale;
    this.publishRadii(false);
  }

  /**
   * Render every atom at a single fixed radius (licorice mode), or revert to
   * per-element vdW radii when `radius` is null. Only the radius buffer is
   * rewritten — colors, positions and per-atom overrides are untouched.
   */
  setUniformRadius(radius: number | null, snapshot: Snapshot): void {
    this.uniformRadius = radius;
    this.rewriteRadii(snapshot);
  }

  /**
   * Set the fraction of the van der Waals radius atoms are drawn at when no
   * uniform radius is active: BALL_STICK_ATOM_SCALE for ball-and-stick,
   * SPACEFILL_ATOM_SCALE for the spacefill spheres of the illustrative
   * representation. A uniform radius (licorice) still wins over this.
   */
  setRadiusScale(scale: number, snapshot: Snapshot): void {
    this.radiusScale = scale;
    this.rewriteRadii(snapshot);
  }

  /**
   * Toggle Mol*-style illustrative shading: a flat, unlit fill plus a
   * constant-width silhouette outline. Purely a shader uniform — geometry,
   * colors and radii are untouched.
   */
  setIllustrative(enabled: boolean): void {
    this.material.uniforms.uIllustrative.value = enabled ? 1 : 0;
  }

  /** Refill the radius buffer from the current uniform-radius / scale state. */
  private rewriteRadii(snapshot: Snapshot): void {
    const { elements } = snapshot;
    for (let i = 0; i < this.nAtoms; i++) {
      this.radiusBuf[i] = this.uniformRadius ?? getRadius(elements[i]) * this.radiusScale;
    }
    this.radiusAttr.needsUpdate = true;
    this.publishRadii(true);
  }

  /** Set global atom opacity. */
  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = opacity;
    this.material.transparent = opacity < 1;
    this.material.depthWrite = opacity >= 1;
    this.material.needsUpdate = true;
    this.publishRadii(false);
  }

  /** Set per-atom scale overrides. */
  setScaleOverrides(overrides: Float32Array): void {
    this.rawScaleBuf.set(overrides.subarray(0, this.nAtoms));
    this._compositeScale();
  }

  /**
   * Hide a subset of atoms (e.g. atoms a per-atom representation draws as
   * lines). Composites with scale overrides rather than clobbering them, and
   * persists across subsequent scale-override writes so the hidden atoms stay
   * hidden until explicitly cleared with `null`.
   */
  setHiddenMask(mask: Uint8Array | null): void {
    if (mask) {
      this.hiddenBuf.set(mask.subarray(0, this.nAtoms));
      if (mask.length < this.nAtoms) this.hiddenBuf.fill(0, mask.length, this.nAtoms);
    } else {
      this.hiddenBuf.fill(0, 0, this.nAtoms);
    }
    this._compositeScale();
  }

  /** Recompute the effective scale buffer as raw * (hidden ? 0 : 1). */
  private _compositeScale(): void {
    let usePerAtom = false;
    for (let i = 0; i < this.nAtoms; i++) {
      const eff = this.hiddenBuf[i] ? 0 : this.rawScaleBuf[i];
      this.scaleOverrideBuf[i] = eff;
      if (eff !== 1) usePerAtom = true;
    }
    this.scaleOverrideAttr.needsUpdate = true;
    if (usePerAtom) this.material.uniforms.uUsePerAtomOverrides.value = 1;
    this.publishRadii(true);
  }

  /** Set per-atom opacity overrides. */
  setOpacityOverrides(overrides: Float32Array): void {
    this.opacityOverrideBuf.set(overrides.subarray(0, this.nAtoms));
    this.opacityOverrideAttr.needsUpdate = true;
    this.material.uniforms.uUsePerAtomOverrides.value = 1;
    // Enable transparency if any atom has opacity < 1
    let hasTransparent = false;
    for (let i = 0; i < this.nAtoms; i++) {
      if (this.opacityOverrideBuf[i] < 1.0) {
        hasTransparent = true;
        break;
      }
    }
    if (hasTransparent) {
      this.material.transparent = true;
      this.material.depthWrite = false;
      this.material.needsUpdate = true;
    }
    this.publishRadii(true);
  }

  /**
   * Clear scale/opacity overrides, reverting to global uniforms. The hidden
   * mask is intentionally preserved — it is owned by the representation layer,
   * not the modify/scale layer — and re-composited so hidden atoms stay hidden
   * even when the per-frame override pass resets scale/opacity.
   */
  clearOverrides(): void {
    this.rawScaleBuf.fill(1.0, 0, this.nAtoms);
    this.opacityOverrideBuf.fill(1.0, 0, this.nAtoms);
    this.opacityOverrideAttr.needsUpdate = true;
    let anyHidden = false;
    for (let i = 0; i < this.nAtoms; i++) {
      if (this.hiddenBuf[i]) {
        anyHidden = true;
        break;
      }
    }
    this.material.uniforms.uUsePerAtomOverrides.value = anyHidden ? 1 : 0;
    this._compositeScale();
  }

  /**
   * Overlay per-atom RGB overrides onto the existing color buffer.
   * `overrides` length must be `nAtoms*3`. Atoms whose r-channel is NaN keep
   * the current (base) color; other atoms are rewritten. The caller is
   * responsible for re-running `loadSnapshot` first when the previous
   * overrides need to be cleared, since this method only writes — it never
   * reverts to base.
   */
  applyColorOverrides(overrides: Float32Array): void {
    const limit = Math.min(this.nAtoms, Math.floor(overrides.length / 3));
    for (let i = 0; i < limit; i++) {
      const i3 = i * 3;
      const r = overrides[i3];
      if (Number.isNaN(r)) continue;
      this.colorBuf[i3] = r;
      this.colorBuf[i3 + 1] = overrides[i3 + 1];
      this.colorBuf[i3 + 2] = overrides[i3 + 2];
    }
    this.colorAttr.needsUpdate = true;
  }

  /**
   * Subscribe to ball-size changes. The callback fires immediately with the
   * current state and again after every restyle, so a subscriber never has to
   * hook the individual mutators. Pass `null` to unsubscribe.
   */
  setRadiusSink(sink: ((radii: Float32Array | null, scale: number) => void) | null): void {
    this.radiusSink = sink;
    this.publishRadii(true);
  }

  /**
   * Per-atom radius before the global multiplier: the base radius (per-element
   * vdW or the licorice uniform radius) × the per-atom scale override. Atoms
   * that render nothing — hidden by a representation, or faded out by a
   * per-atom opacity override — report 0, which tells the bond shader not to
   * trim its sticks against a ball that isn't there.
   */
  getBaseRadii(): Float32Array {
    const n = this.nAtoms;
    if (this.baseRadiusBuf.length < n) this.baseRadiusBuf = new Float32Array(n);
    const usePerAtom = this.material.uniforms.uUsePerAtomOverrides.value === 1;
    for (let i = 0; i < n; i++) {
      const visible = !usePerAtom || this.opacityOverrideBuf[i] > 0;
      const scaleOverride = usePerAtom ? this.scaleOverrideBuf[i] : 1;
      this.baseRadiusBuf[i] = visible ? this.radiusBuf[i] * scaleOverride : 0;
    }
    return this.baseRadiusBuf.subarray(0, n);
  }

  /**
   * Global multiplier on top of `getBaseRadii`, or 0 when the atoms are faded
   * out entirely — both are plain uniform reads, so pushing them stays O(1).
   */
  getRadiusScale(): number {
    const opacity = this.material.uniforms.uOpacity.value as number;
    return opacity > 0 ? (this.material.uniforms.uScaleMultiplier.value as number) : 0;
  }

  /**
   * Notify the sink. `perAtomChanged` is false for the global scale / opacity
   * uniforms, which must stay O(1) — they are advertised as such and run on
   * every pipeline apply.
   */
  private publishRadii(perAtomChanged: boolean): void {
    this.radiusSink?.(perAtomChanged ? this.getBaseRadii() : null, this.getRadiusScale());
  }

  /**
   * Read-only handle on the per-atom RGB buffer (length `nAtoms*3`).
   * Used by the bond mesh to derive per-bond colors after overrides are
   * applied; do not mutate the returned subarray.
   */
  getColorBuffer(): Float32Array {
    return this.colorBuf.subarray(0, this.nAtoms * 3);
  }

  private grow(needed: number): void {
    // Three.js caches `_maxInstanceCount` the first time an instanced geometry
    // is bound. Replacing the instance attributes alone does not invalidate
    // that cache, so a mesh that started with capacity 1 would keep drawing at
    // most one instance after growing. Dispose the GPU-side geometry before
    // replacing its attributes; the CPU-side index/vertex data remains valid
    // and is uploaded again on the next render. Clear the cache explicitly as
    // well so growth is correct before a renderer has attached its dispose
    // listener (for example, in headless use).
    this.geo.dispose();
    delete (this.geo as THREE.InstancedBufferGeometry & { _maxInstanceCount?: number })
      ._maxInstanceCount;

    this.capacity = Math.max(needed, this.capacity * 2);

    const newCenter = new Float32Array(this.capacity * 3);
    const newRadius = new Float32Array(this.capacity);
    const newColor = new Float32Array(this.capacity * 3);
    const newScaleOverride = new Float32Array(this.capacity).fill(1.0);
    const newOpacityOverride = new Float32Array(this.capacity).fill(1.0);
    const newRawScale = new Float32Array(this.capacity).fill(1.0);
    const newHidden = new Uint8Array(this.capacity);

    newCenter.set(this.centerBuf);
    newRadius.set(this.radiusBuf);
    newColor.set(this.colorBuf);
    newScaleOverride.set(this.scaleOverrideBuf);
    newOpacityOverride.set(this.opacityOverrideBuf);
    newRawScale.set(this.rawScaleBuf);
    newHidden.set(this.hiddenBuf);

    this.centerBuf = newCenter;
    this.radiusBuf = newRadius;
    this.colorBuf = newColor;
    this.scaleOverrideBuf = newScaleOverride;
    this.opacityOverrideBuf = newOpacityOverride;
    this.rawScaleBuf = newRawScale;
    this.hiddenBuf = newHidden;

    this.centerAttr = new THREE.InstancedBufferAttribute(this.centerBuf, 3);
    this.radiusAttr = new THREE.InstancedBufferAttribute(this.radiusBuf, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorBuf, 3);
    this.scaleOverrideAttr = new THREE.InstancedBufferAttribute(this.scaleOverrideBuf, 1);
    this.opacityOverrideAttr = new THREE.InstancedBufferAttribute(this.opacityOverrideBuf, 1);

    this.centerAttr.setUsage(THREE.DynamicDrawUsage);
    this.radiusAttr.setUsage(THREE.StaticDrawUsage);
    this.colorAttr.setUsage(THREE.StaticDrawUsage);
    this.scaleOverrideAttr.setUsage(THREE.DynamicDrawUsage);
    this.opacityOverrideAttr.setUsage(THREE.DynamicDrawUsage);

    this.geo.setAttribute("instanceCenter", this.centerAttr);
    this.geo.setAttribute("instanceRadius", this.radiusAttr);
    this.geo.setAttribute("instanceColor", this.colorAttr);
    this.geo.setAttribute("instanceScaleOverride", this.scaleOverrideAttr);
    this.geo.setAttribute("instanceOpacityOverride", this.opacityOverrideAttr);
  }

  dispose(): void {
    this.radiusSink = null;
    this.geo.dispose();
    this.material.dispose();
  }
}
