/**
 * Billboard impostor cylinder renderer for bonds.
 *
 * Each bond is a screen-aligned quad stretched between two atom positions.
 * Fragment shader applies cylinder-like shading.
 * Supports bond orders: single, double, triple, aromatic (dashed).
 * Single instanced draw call for all bonds.
 *
 * GPU-optimized: atom positions are uploaded as a DataTexture and bond
 * topology (atom indices + offsets) is stored as static instance attributes.
 * Per-frame update is O(nAtoms) texture copy instead of O(nVisualBonds) vector math.
 */

import * as THREE from "three";
import type { Snapshot } from "../types";
import { type ColorContext, getAtomColorForScheme } from "../colorSchemes";
import {
  getColor,
  getRadius,
  BALL_STICK_ATOM_SCALE,
  BOND_RADIUS,
  BOND_SINGLE,
  BOND_DOUBLE,
  BOND_TRIPLE,
  BOND_AROMATIC,
  DOUBLE_BOND_OFFSET,
  DOUBLE_BOND_RADIUS,
  TRIPLE_BOND_OFFSET,
  TRIPLE_BOND_RADIUS,
  AROMATIC_BOND_RADIUS,
  AROMATIC_DASH_RADIUS,
} from "../constants";
import { bondVertexShader, bondFragmentShader } from "./shaders";

const TEX_MAX_WIDTH = 4096;

export class ImpostorBondMesh {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private bondMaterial: THREE.RawShaderMaterial;

  // Topology buffers (set at loadSnapshot, static per snapshot)
  private atomABuf: Float32Array;
  private atomBBuf: Float32Array;
  private offsetXBuf: Float32Array;
  private offsetYBuf: Float32Array;
  // Two endpoint colors per visual instance: A = atomA side, B = atomB side.
  // The bond fragment shader splits the cylinder at its midpoint so each half
  // takes its endpoint atom's color.
  private colorABuf: Float32Array;
  private colorBBuf: Float32Array;
  private radiusBuf: Float32Array;
  // CPU-only mirror of the per-order default radius for each visual instance.
  // Lets setUniformRadius(null) restore licorice → ball-and-stick without
  // re-walking bond topology.
  private baseRadiusBuf: Float32Array;
  private dashedBuf: Float32Array;
  private opacityBuf: Float32Array; // per-visual-instance opacity override
  private logicalBondIdx: Float32Array; // CPU-only: maps visual instance → logical bond index
  // When non-null, every visual bond renders at this fixed radius (licorice
  // mode); when null, radii fall back to the per-order defaults.
  private uniformRadius: number | null = null;
  // Per-atom hide flags (1 = hidden). A bond with a hidden endpoint renders at
  // radius 0 (the shader discards a degenerate cylinder) so atoms drawn as
  // lines by a per-atom representation don't also show cylinder bonds.
  private hiddenAtomMask: Uint8Array | null = null;

  // Persistent InstancedBufferAttribute references. Recreated only when the
  // backing typed arrays are reallocated by grow(); otherwise we just flip
  // needsUpdate to re-upload, so the old GL buffer is reused (and not leaked).
  private atomAAttr!: THREE.InstancedBufferAttribute;
  private atomBAttr!: THREE.InstancedBufferAttribute;
  private offsetXAttr!: THREE.InstancedBufferAttribute;
  private offsetYAttr!: THREE.InstancedBufferAttribute;
  private colorAAttr!: THREE.InstancedBufferAttribute;
  private colorBAttr!: THREE.InstancedBufferAttribute;
  private radiusAttr!: THREE.InstancedBufferAttribute;
  private dashedAttr!: THREE.InstancedBufferAttribute;
  private opacityAttr!: THREE.InstancedBufferAttribute;

  // Position DataTexture (updated per frame)
  private positionTex: THREE.DataTexture;
  private positionTexData: Float32Array;
  private positionTexWidth: number = 1;
  private positionTexHeight: number = 1;
  private nAtoms: number = 0;
  /**
   * Per-atom sphere radius the atom impostor is currently drawing, mirrored so
   * it survives a topology rebuild. Rides in the alpha channel of the position
   * texture (RGB = position) so the bond shader can trim each stick at the
   * ball's surface without a second texture fetch. Zero means "no ball here",
   * which disables the trim for that endpoint.
   */
  private atomRadii: Float32Array = new Float32Array(0);
  private nAtomRadii: number = 0;

  private capacity: number;

  constructor(maxBonds: number = 3_000_000) {
    this.capacity = maxBonds;

    // Quad: 2 triangles, XY in [-1, 1]
    this.geo = new THREE.InstancedBufferGeometry();
    const verts = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const uvs = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    this.geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geo.instanceCount = 0;

    // Instance buffers
    this.atomABuf = new Float32Array(maxBonds);
    this.atomBBuf = new Float32Array(maxBonds);
    this.offsetXBuf = new Float32Array(maxBonds);
    this.offsetYBuf = new Float32Array(maxBonds);
    this.colorABuf = new Float32Array(maxBonds * 3);
    this.colorBBuf = new Float32Array(maxBonds * 3);
    this.radiusBuf = new Float32Array(maxBonds);
    this.baseRadiusBuf = new Float32Array(maxBonds);
    this.dashedBuf = new Float32Array(maxBonds);
    this.opacityBuf = new Float32Array(maxBonds).fill(1.0);
    this.logicalBondIdx = new Float32Array(maxBonds);

    // Initial DataTexture (1x1 placeholder)
    this.positionTexData = new Float32Array(4);
    this.positionTex = new THREE.DataTexture(
      this.positionTexData,
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.positionTex.minFilter = THREE.NearestFilter;
    this.positionTex.magFilter = THREE.NearestFilter;
    this.positionTex.generateMipmaps = false;
    this.positionTex.needsUpdate = true;

    // Register initial attributes
    this.registerAttributes();

    this.bondMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: bondVertexShader,
      fragmentShader: bondFragmentShader,
      uniforms: {
        uOpacity: { value: 1.0 },
        uBondScaleMultiplier: { value: 1.0 },
        // Global multiplier on the per-atom trim radii in the position
        // texture's alpha channel; 0 disables the junction trim entirely.
        uAtomRadiusScale: { value: 1.0 },
        uPositionTex: { value: this.positionTex },
        uPositionTexWidth: { value: 1 },
        uUsePerBondOverrides: { value: 0 },
      },
      depthWrite: true,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(this.geo, this.bondMaterial);
    this.mesh.frustumCulled = false;
  }

  loadSnapshot(snapshot: Snapshot, colorCtx?: ColorContext): void {
    const { nAtoms, nBonds, positions, elements, bonds, bondOrders } = snapshot;
    this.nAtoms = nAtoms;

    // Resize position texture
    this.positionTexWidth = Math.min(nAtoms, TEX_MAX_WIDTH);
    this.positionTexHeight = Math.max(1, Math.ceil(nAtoms / this.positionTexWidth));
    this.positionTexData = new Float32Array(this.positionTexWidth * this.positionTexHeight * 4);
    this.copyPositionsToTexData(positions);
    this.seedAtomRadiiFromElements(elements);

    this.positionTex.dispose();
    this.positionTex = new THREE.DataTexture(
      this.positionTexData,
      this.positionTexWidth,
      this.positionTexHeight,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.positionTex.minFilter = THREE.NearestFilter;
    this.positionTex.magFilter = THREE.NearestFilter;
    this.positionTex.generateMipmaps = false;
    this.positionTex.needsUpdate = true;
    this.bondMaterial.uniforms.uPositionTex.value = this.positionTex;
    this.bondMaterial.uniforms.uPositionTexWidth.value = this.positionTexWidth;

    // Count total visual instances
    let totalInstances = 0;
    for (let i = 0; i < nBonds; i++) {
      const order = bondOrders ? bondOrders[i] : BOND_SINGLE;
      if (order === BOND_DOUBLE) totalInstances += 2;
      else if (order === BOND_TRIPLE) totalInstances += 3;
      else if (order === BOND_AROMATIC) totalInstances += 2;
      else totalInstances += 1;
    }

    if (totalInstances > this.capacity) {
      this.grow(totalInstances);
    }

    let idx = 0;

    for (let i = 0; i < nBonds; i++) {
      const ai = bonds[i * 2];
      const bi = bonds[i * 2 + 1];
      const order = bondOrders ? bondOrders[i] : BOND_SINGLE;

      // Split coloring: atomA color on the A half, atomB color on the B half.
      const [ar, ag, ab] = colorCtx
        ? getAtomColorForScheme(ai, snapshot, colorCtx)
        : getColor(elements[ai]);
      const [br, bg, bb] = colorCtx
        ? getAtomColorForScheme(bi, snapshot, colorCtx)
        : getColor(elements[bi]);

      if (order === BOND_DOUBLE) {
        for (const sign of [-1, 1]) {
          this.setTopology(
            idx,
            ai,
            bi,
            sign * DOUBLE_BOND_OFFSET,
            0,
            DOUBLE_BOND_RADIUS,
            ar,
            ag,
            ab,
            br,
            bg,
            bb,
            0,
          );
          this.logicalBondIdx[idx] = i;
          this.opacityBuf[idx] = 1.0;
          idx++;
        }
      } else if (order === BOND_TRIPLE) {
        const angles = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
        for (const angle of angles) {
          const ox = Math.cos(angle) * TRIPLE_BOND_OFFSET;
          const oy = Math.sin(angle) * TRIPLE_BOND_OFFSET;
          this.setTopology(idx, ai, bi, ox, oy, TRIPLE_BOND_RADIUS, ar, ag, ab, br, bg, bb, 0);
          this.logicalBondIdx[idx] = i;
          this.opacityBuf[idx] = 1.0;
          idx++;
        }
      } else if (order === BOND_AROMATIC) {
        // Solid bond
        this.setTopology(idx, ai, bi, 0, 0, AROMATIC_BOND_RADIUS, ar, ag, ab, br, bg, bb, 0);
        this.logicalBondIdx[idx] = i;
        this.opacityBuf[idx] = 1.0;
        idx++;
        // Dashed offset bond
        this.setTopology(
          idx,
          ai,
          bi,
          DOUBLE_BOND_OFFSET,
          0,
          AROMATIC_DASH_RADIUS,
          ar,
          ag,
          ab,
          br,
          bg,
          bb,
          1,
        );
        this.logicalBondIdx[idx] = i;
        this.opacityBuf[idx] = 1.0;
        idx++;
      } else {
        // Single bond
        this.setTopology(idx, ai, bi, 0, 0, BOND_RADIUS, ar, ag, ab, br, bg, bb, 0);
        this.logicalBondIdx[idx] = i;
        this.opacityBuf[idx] = 1.0;
        idx++;
      }
    }

    // Reset per-bond override mode when loading a new snapshot
    this.bondMaterial.uniforms.uUsePerBondOverrides.value = 0;

    // Re-upload existing GL buffers in place. Recreating the
    // InstancedBufferAttributes here would orphan the previous GL buffers
    // (Three.js only frees them on the attribute's own dispose event), and
    // when bondSource="distance" loadSnapshot runs every frame — that path
    // exhausted GPU memory and triggered WebGL context loss.
    this.markAttributesDirty();
    this.geo.instanceCount = idx;
    // Re-apply a persistent hide mask onto the freshly built topology.
    this._compositeRadius();
  }

  updatePositions(positions: Float32Array, _bonds: Uint32Array, _nBonds: number): void {
    this.copyPositionsToTexData(positions);
    this.positionTex.needsUpdate = true;
  }

  /**
   * Recompute per-instance bond colors from a caller-supplied per-atom RGB
   * buffer (length === `snapshot.nAtoms * 3`). The fan-out for double / triple
   * / aromatic bonds is reproduced exactly as `loadSnapshot` did, so a single
   * call replaces the GPU color buffer in place.
   *
   * Used after `ImpostorAtomMesh.applyColorOverrides` has updated atom colors
   * — this propagates the updated palette to bonds without re-uploading the
   * topology buffers.
   */
  recomputeColorsFromAtomBuffer(atomColors: Float32Array, snapshot: Snapshot): void {
    const { nBonds, bonds, bondOrders, elements } = snapshot;
    // The atom color buffer only covers real atoms. PBC half-bonds reference
    // ghost atoms appended past that range (index >= nRealAtoms); reading them
    // from `atomColors` yields undefined → NaN → black. Fall back to the ghost
    // atom's element color, which `processPbcBonds` set on the extended
    // `elements` array, so boundary stubs keep their proper CPK color.
    const nRealAtoms = atomColors.length / 3;
    const endpointColor = (idx: number): [number, number, number] => {
      if (idx < nRealAtoms) {
        const i3 = idx * 3;
        return [atomColors[i3], atomColors[i3 + 1], atomColors[i3 + 2]];
      }
      return getColor(elements[idx]);
    };
    let idx = 0;
    for (let i = 0; i < nBonds; i++) {
      const ai = bonds[i * 2];
      const bi = bonds[i * 2 + 1];
      const order = bondOrders ? bondOrders[i] : BOND_SINGLE;

      const [ar, ag, ab] = endpointColor(ai);
      const [br, bg, bb] = endpointColor(bi);

      let perBond = 1;
      if (order === BOND_DOUBLE || order === BOND_AROMATIC) perBond = 2;
      else if (order === BOND_TRIPLE) perBond = 3;

      for (let k = 0; k < perBond; k++) {
        const j3 = idx * 3;
        this.colorABuf[j3] = ar;
        this.colorABuf[j3 + 1] = ag;
        this.colorABuf[j3 + 2] = ab;
        this.colorBBuf[j3] = br;
        this.colorBBuf[j3 + 1] = bg;
        this.colorBBuf[j3 + 2] = bb;
        idx++;
      }
    }
    this.colorAAttr.needsUpdate = true;
    this.colorBAttr.needsUpdate = true;
  }

  private setTopology(
    idx: number,
    ai: number,
    bi: number,
    offsetX: number,
    offsetY: number,
    radius: number,
    ar: number,
    ag: number,
    ab: number,
    br: number,
    bg: number,
    bb: number,
    dashed: number,
  ): void {
    this.atomABuf[idx] = ai;
    this.atomBBuf[idx] = bi;
    this.offsetXBuf[idx] = offsetX;
    this.offsetYBuf[idx] = offsetY;

    const i3 = idx * 3;
    this.colorABuf[i3] = ar;
    this.colorABuf[i3 + 1] = ag;
    this.colorABuf[i3 + 2] = ab;
    this.colorBBuf[i3] = br;
    this.colorBBuf[i3 + 1] = bg;
    this.colorBBuf[i3 + 2] = bb;

    this.baseRadiusBuf[idx] = radius;
    this.radiusBuf[idx] = this.uniformRadius ?? radius;
    this.dashedBuf[idx] = dashed;
  }

  /**
   * Render every visual bond at a single fixed radius (licorice mode), or
   * revert to the per-order defaults when `radius` is null. Only the radius
   * buffer is rewritten — topology and colors are untouched.
   */
  setUniformRadius(radius: number | null, _snapshot?: Snapshot): void {
    this.uniformRadius = radius;
    this._compositeRadius();
  }

  /**
   * Hide every bond with at least one endpoint atom flagged in `mask`
   * (`mask[i] === 1`); `null` shows all bonds. Persists across topology
   * rebuilds and licorice radius changes.
   */
  setHiddenMask(mask: Uint8Array | null): void {
    this.hiddenAtomMask = mask ? new Uint8Array(mask) : null;
    this._compositeRadius();
  }

  /** Write the effective radius buffer, zeroing bonds with a hidden endpoint. */
  private _compositeRadius(): void {
    const count = this.geo.instanceCount;
    const mask = this.hiddenAtomMask;
    for (let v = 0; v < count; v++) {
      const base = this.uniformRadius ?? this.baseRadiusBuf[v];
      if (mask && (mask[this.atomABuf[v]] === 1 || mask[this.atomBBuf[v]] === 1)) {
        this.radiusBuf[v] = 0;
      } else {
        this.radiusBuf[v] = base;
      }
    }
    this.radiusAttr.needsUpdate = true;
  }

  private copyPositionsToTexData(positions: Float32Array): void {
    const data = this.positionTexData;
    const n = this.nAtoms;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const i4 = i * 4;
      data[i4] = positions[i3];
      data[i4 + 1] = positions[i3 + 1];
      data[i4 + 2] = positions[i3 + 2];
      // data[i4 + 3] is the atom's sphere radius, written by
      // seedAtomRadiiFromElements / setAtomRadii — never clobber it here, this
      // runs every frame while radii only change when the atoms are restyled.
    }
  }

  /**
   * Fill the radius channel with each atom's default ball-and-stick radius.
   * Runs on every topology rebuild so PBC ghost atoms — which live past the
   * real-atom range and are drawn by a separate boundary renderer — get a
   * sensible trim radius; setAtomRadii then overwrites the real atoms with
   * whatever the atom impostor actually has on screen.
   */
  private seedAtomRadiiFromElements(elements: Uint8Array): void {
    const data = this.positionTexData;
    for (let i = 0; i < this.nAtoms; i++) {
      data[i * 4 + 3] = getRadius(elements[i]) * BALL_STICK_ATOM_SCALE;
    }
    this.writeAtomRadiiToTexData();
  }

  /**
   * Mirror the atom impostor's per-atom radii (base radius × per-atom scale
   * override, zeroed for invisible atoms) so the bond shader can trim each
   * stick where it enters a ball. Called by the owning layer whenever the atom
   * renderer restyles; the values are cached and re-applied after every
   * topology rebuild.
   */
  setAtomRadii(radii: Float32Array): void {
    const n = radii.length;
    if (this.atomRadii.length < n) this.atomRadii = new Float32Array(n);
    this.atomRadii.set(radii);
    this.nAtomRadii = n;
    if (this.writeAtomRadiiToTexData()) {
      this.positionTex.needsUpdate = true;
    }
  }

  /**
   * Global multiplier the shader applies to those radii, matching the atom
   * impostor's own scale uniform. 0 means the atoms draw nothing, which turns
   * the trim off so sticks stay whole. O(1), so the atom mesh's O(1) scale /
   * opacity updates stay O(1) here too.
   */
  setAtomRadiusScale(scale: number): void {
    this.bondMaterial.uniforms.uAtomRadiusScale.value = scale;
  }

  /** Copy the mirrored radii into the texture's alpha channel. */
  private writeAtomRadiiToTexData(): boolean {
    const limit = Math.min(this.nAtoms, this.nAtomRadii);
    if (limit === 0) return false;
    const data = this.positionTexData;
    for (let i = 0; i < limit; i++) {
      data[i * 4 + 3] = this.atomRadii[i];
    }
    return true;
  }

  /**
   * (Re)allocate all instance attributes and register them with the
   * geometry. Disposes any previously-held attributes first so their GL
   * buffers are released — this is the only path that should churn GPU
   * memory, and it only runs at construction and when grow() reallocates
   * the typed arrays.
   */
  private registerAttributes(): void {
    this.disposeAttributes();

    this.atomAAttr = new THREE.InstancedBufferAttribute(this.atomABuf, 1);
    this.atomBAttr = new THREE.InstancedBufferAttribute(this.atomBBuf, 1);
    this.offsetXAttr = new THREE.InstancedBufferAttribute(this.offsetXBuf, 1);
    this.offsetYAttr = new THREE.InstancedBufferAttribute(this.offsetYBuf, 1);
    this.colorAAttr = new THREE.InstancedBufferAttribute(this.colorABuf, 3);
    this.colorBAttr = new THREE.InstancedBufferAttribute(this.colorBBuf, 3);
    this.radiusAttr = new THREE.InstancedBufferAttribute(this.radiusBuf, 1);
    this.dashedAttr = new THREE.InstancedBufferAttribute(this.dashedBuf, 1);
    this.opacityAttr = new THREE.InstancedBufferAttribute(this.opacityBuf, 1);

    this.geo.setAttribute("instanceAtomA", this.atomAAttr);
    this.geo.setAttribute("instanceAtomB", this.atomBAttr);
    this.geo.setAttribute("instanceOffsetX", this.offsetXAttr);
    this.geo.setAttribute("instanceOffsetY", this.offsetYAttr);
    this.geo.setAttribute("instanceColorA", this.colorAAttr);
    this.geo.setAttribute("instanceColorB", this.colorBAttr);
    this.geo.setAttribute("instanceRadius", this.radiusAttr);
    this.geo.setAttribute("instanceDashed", this.dashedAttr);
    this.geo.setAttribute("instanceBondOpacity", this.opacityAttr);
  }

  private disposeAttributes(): void {
    // Three.js' WebGLAttributes registers a `dispose` listener on each
    // BufferAttribute and frees the GL buffer when the event fires.
    // BufferAttribute extends EventDispatcher at runtime but @types/three
    // 0.183 omits it, so we cast to a minimal disposable shape. Without
    // this, swapping attributes via setAttribute leaks the previous GL
    // buffers — fatal under per-frame VDW bond recalculation.
    type Disposable = {
      dispose?: () => void;
      dispatchEvent?: (e: { type: string }) => void;
    };
    const dispose = (a: THREE.InstancedBufferAttribute | undefined) => {
      if (!a) return;
      const d = a as unknown as Disposable;
      if (typeof d.dispose === "function") d.dispose();
      else d.dispatchEvent?.({ type: "dispose" });
    };
    dispose(this.atomAAttr);
    dispose(this.atomBAttr);
    dispose(this.offsetXAttr);
    dispose(this.offsetYAttr);
    dispose(this.colorAAttr);
    dispose(this.colorBAttr);
    dispose(this.radiusAttr);
    dispose(this.dashedAttr);
    dispose(this.opacityAttr);
  }

  private markAttributesDirty(): void {
    this.atomAAttr.needsUpdate = true;
    this.atomBAttr.needsUpdate = true;
    this.offsetXAttr.needsUpdate = true;
    this.offsetYAttr.needsUpdate = true;
    this.colorAAttr.needsUpdate = true;
    this.colorBAttr.needsUpdate = true;
    this.radiusAttr.needsUpdate = true;
    this.dashedAttr.needsUpdate = true;
    this.opacityAttr.needsUpdate = true;
  }

  private grow(needed: number): void {
    this.capacity = Math.max(needed, this.capacity * 2);

    const newAtomA = new Float32Array(this.capacity);
    const newAtomB = new Float32Array(this.capacity);
    const newOffsetX = new Float32Array(this.capacity);
    const newOffsetY = new Float32Array(this.capacity);
    const newColorA = new Float32Array(this.capacity * 3);
    const newColorB = new Float32Array(this.capacity * 3);
    const newRadius = new Float32Array(this.capacity);
    const newBaseRadius = new Float32Array(this.capacity);
    const newDashed = new Float32Array(this.capacity);
    const newOpacity = new Float32Array(this.capacity).fill(1.0);
    const newLogical = new Float32Array(this.capacity);

    newAtomA.set(this.atomABuf);
    newAtomB.set(this.atomBBuf);
    newOffsetX.set(this.offsetXBuf);
    newOffsetY.set(this.offsetYBuf);
    newColorA.set(this.colorABuf);
    newColorB.set(this.colorBBuf);
    newRadius.set(this.radiusBuf);
    newBaseRadius.set(this.baseRadiusBuf);
    newDashed.set(this.dashedBuf);
    newOpacity.set(this.opacityBuf);
    newLogical.set(this.logicalBondIdx);

    this.atomABuf = newAtomA;
    this.atomBBuf = newAtomB;
    this.offsetXBuf = newOffsetX;
    this.offsetYBuf = newOffsetY;
    this.colorABuf = newColorA;
    this.colorBBuf = newColorB;
    this.radiusBuf = newRadius;
    this.baseRadiusBuf = newBaseRadius;
    this.dashedBuf = newDashed;
    this.opacityBuf = newOpacity;
    this.logicalBondIdx = newLogical;

    this.registerAttributes();
  }

  /** Set global bond opacity. */
  setOpacity(opacity: number): void {
    this.bondMaterial.uniforms.uOpacity.value = opacity;
    this.bondMaterial.transparent = opacity < 1;
    this.bondMaterial.depthWrite = opacity >= 1;
    this.bondMaterial.needsUpdate = true;
  }

  /**
   * Apply per-bond opacity overrides (one value per logical bond).
   * Maps logical bond opacities to visual instances and activates per-bond mode.
   */
  setBondOpacityOverrides(logicalOpacities: Float32Array): void {
    const count = this.geo.instanceCount;
    for (let v = 0; v < count; v++) {
      const li = this.logicalBondIdx[v];
      this.opacityBuf[v] = logicalOpacities[li] ?? 1.0;
    }
    const attr = this.geo.getAttribute("instanceBondOpacity") as THREE.InstancedBufferAttribute;
    if (attr) attr.needsUpdate = true;
    this.bondMaterial.uniforms.uUsePerBondOverrides.value = 1;
    this.bondMaterial.transparent = true;
    this.bondMaterial.depthWrite = false;
    this.bondMaterial.needsUpdate = true;
  }

  /** Clear per-bond opacity overrides, reverting to global opacity mode. */
  clearBondOpacityOverrides(): void {
    this.opacityBuf.fill(1.0);
    const attr = this.geo.getAttribute("instanceBondOpacity") as THREE.InstancedBufferAttribute;
    if (attr) attr.needsUpdate = true;
    this.bondMaterial.uniforms.uUsePerBondOverrides.value = 0;
    this.bondMaterial.needsUpdate = true;
  }

  /** Set bond radius scale multiplier (O(1) via shader uniform). */
  setScale(scale: number, _snapshot?: Snapshot): void {
    this.bondMaterial.uniforms.uBondScaleMultiplier.value = scale;
  }

  dispose(): void {
    this.geo.dispose();
    this.bondMaterial.dispose();
    this.positionTex.dispose();
  }
}
