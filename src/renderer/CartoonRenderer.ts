/**
 * Cartoon / ribbon representation renderer for proteins.
 *
 * Renders the entire backbone of each chain as a single continuous ribbon
 * whose cross-section morphs smoothly between secondary-structure types:
 *  - Coil  (ss=0): thin circular tube
 *  - Helix (ss=1): wide rounded ribbon
 *  - Sheet (ss=2): wide flat ribbon, ending in a tapered arrowhead
 *
 * Goals: match the visual quality of Mol* / PyMOL cartoons:
 *  - High sub-resolution sampling (10 samples per residue) for smooth curvature
 *  - Rounded rectangular cross-sections (16 points around the perimeter)
 *  - Smooth taper of width/thickness/color at SS boundaries via per-residue
 *    parameter interpolation along the spline
 *  - Sheet arrowheads with widened base + zero-width knife-edge tip
 *  - Vertex colors so SS color transitions are interpolated, not stepped
 *  - MeshStandardMaterial for physically-plausible shading
 *
 * Data flows in via loadSnapshot() (first frame) and updatePositions() (trajectory).
 * The renderer owns a THREE.Group that is added to the scene by MoleculeRenderer.
 */

import * as THREE from "three";
import type { Snapshot } from "../types";
import { perfMark, perfMeasure } from "../perf";

/** Secondary structure type constants. */
export const SS_COIL = 0;
export const SS_HELIX = 1;
export const SS_SHEET = 2;

/** RGB colors used for each secondary structure type (vertex-color targets). */
const SS_COLORS_HEX: Record<number, number> = {
  [SS_COIL]: 0x9ca3af, // gray
  [SS_HELIX]: 0xef4444, // red
  [SS_SHEET]: 0x3b82f6, // blue
};
const SS_COLOR_VECS: Record<number, THREE.Color> = {
  [SS_COIL]: new THREE.Color(SS_COLORS_HEX[SS_COIL]),
  [SS_HELIX]: new THREE.Color(SS_COLORS_HEX[SS_HELIX]),
  [SS_SHEET]: new THREE.Color(SS_COLORS_HEX[SS_SHEET]),
};

/** A contiguous run of Cα atoms sharing the same secondary structure type. */
export interface BackboneSegment {
  caSliceStart: number;
  caSliceEnd: number; // exclusive
  ssType: number;
}

/** Per-chain ordered Cα backbone data extracted from a Snapshot. */
export interface ChainBackbone {
  chainId: number; // ASCII byte of the chain letter
  atomIndices: Uint32Array;
  ssTypes: Uint8Array;
}

// ─── Backbone extraction (unchanged from prior API) ───────────────────────────

export function extractChainBackbones(snapshot: Snapshot): ChainBackbone[] {
  const { caIndices, caChainIds, caResNums, caSsType } = snapshot;
  if (!caIndices || !caChainIds || !caResNums || !caSsType || caIndices.length === 0) {
    return [];
  }

  const chainMap = new Map<number, number[]>();
  for (let i = 0; i < caIndices.length; i++) {
    const chain = caChainIds[i];
    let list = chainMap.get(chain);
    if (!list) {
      list = [];
      chainMap.set(chain, list);
    }
    list.push(i);
  }

  const chains: ChainBackbone[] = [];
  for (const [chainId, caPositions] of chainMap) {
    caPositions.sort((a, b) => caResNums[a] - caResNums[b]);
    const atomIndices = new Uint32Array(caPositions.length);
    const ssTypes = new Uint8Array(caPositions.length);
    for (let k = 0; k < caPositions.length; k++) {
      atomIndices[k] = caIndices[caPositions[k]];
      ssTypes[k] = caSsType[caPositions[k]];
    }
    chains.push({ chainId, atomIndices, ssTypes });
  }
  return chains;
}

/** Split per-Cα SS types into contiguous segments. Kept for backwards-compatible API. */
export function buildSegments(ssTypes: Uint8Array): BackboneSegment[] {
  const segments: BackboneSegment[] = [];
  if (ssTypes.length === 0) return segments;
  let start = 0;
  let current = ssTypes[0];
  for (let i = 1; i < ssTypes.length; i++) {
    if (ssTypes[i] !== current) {
      segments.push({ caSliceStart: start, caSliceEnd: i, ssType: current });
      start = i;
      current = ssTypes[i];
    }
  }
  segments.push({ caSliceStart: start, caSliceEnd: ssTypes.length, ssType: current });
  return segments;
}

// ─── Tunable geometry parameters ──────────────────────────────────────────────

/** Cross-section profile for one Cα residue (Å). */
interface CrossSection {
  halfWidth: number;
  halfThick: number;
  cornerRadius: number;
}

const COIL_PROFILE: CrossSection = { halfWidth: 0.22, halfThick: 0.22, cornerRadius: 0.22 };
const HELIX_PROFILE: CrossSection = { halfWidth: 0.95, halfThick: 0.2, cornerRadius: 0.12 };
const SHEET_PROFILE: CrossSection = { halfWidth: 1.05, halfThick: 0.2, cornerRadius: 0.1 };
const SHEET_ARROW_BASE_HALF_WIDTH = 1.65;
const SHEET_ARROW_TIP_HALF_WIDTH = 0.0;

const SAMPLES_PER_RESIDUE = 10;
const CROSS_SECTION_POINTS = 16;

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Look up the base cross-section profile for an SS type. */
function profileFor(ss: number): CrossSection {
  if (ss === SS_HELIX) return HELIX_PROFILE;
  if (ss === SS_SHEET) return SHEET_PROFILE;
  return COIL_PROFILE;
}

/**
 * Compute per-residue cross-section parameters and color, applying the sheet-arrow
 * profile to the final 2 residues of every β-strand run.
 *
 * The arrow profile widens the second-to-last sheet residue to ARROW_BASE width
 * then collapses the very last one to a knife-edge tip (width 0). This produces
 * the iconic Mol* / PyMOL arrowhead while keeping the geometry one continuous mesh.
 */
export function computeRibbonProfile(ssTypes: Uint8Array): {
  profiles: CrossSection[];
  colors: THREE.Color[];
} {
  const n = ssTypes.length;
  const profiles: CrossSection[] = new Array(n);
  const colors: THREE.Color[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const ss = ssTypes[i];
    profiles[i] = { ...profileFor(ss) };
    colors[i] = SS_COLOR_VECS[ss] ?? SS_COLOR_VECS[SS_COIL];
  }

  // Arrow profile: locate sheet runs of length ≥ 2 and reshape their last 2 residues.
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const inSheet = i < n && ssTypes[i] === SS_SHEET;
    if (inSheet && runStart < 0) {
      runStart = i;
    } else if (!inSheet && runStart >= 0) {
      const runEnd = i; // exclusive
      const len = runEnd - runStart;
      if (len >= 2) {
        // second-to-last → arrow base (wide)
        profiles[runEnd - 2] = {
          halfWidth: SHEET_ARROW_BASE_HALF_WIDTH,
          halfThick: SHEET_PROFILE.halfThick,
          cornerRadius: SHEET_PROFILE.cornerRadius,
        };
        // last → knife-edge tip
        profiles[runEnd - 1] = {
          halfWidth: SHEET_ARROW_TIP_HALF_WIDTH,
          halfThick: SHEET_PROFILE.halfThick,
          cornerRadius: 0,
        };
      }
      runStart = -1;
    }
  }

  return { profiles, colors };
}

/**
 * Sample K points uniformly along the perimeter (by arclength) of an axis-aligned
 * rounded rectangle with given half-width W, half-thickness T, corner radius R.
 *
 * Returns positions in 2D cross-section space (x = ribbon-side direction,
 * y = ribbon-face direction) plus outward unit normals.
 *
 * Degenerate case W ≈ 0: collapse to a knife-edge — cross-section becomes a
 * vertical line of doubled vertices (top half on +x side, bottom half on −x).
 * This produces a flat triangular sheet arrow tip in world space.
 */
export function buildCrossSection(
  K: number,
  W: number,
  T: number,
  R: number,
): { x: number; y: number; nx: number; ny: number }[] {
  // Knife-edge degenerate: use a vertical line, half the ring on each face normal.
  // Each "side" gets K/2 points distributed along y from +T to −T (or back).
  if (W < 1e-4) {
    const out: { x: number; y: number; nx: number; ny: number }[] = [];
    const half = K / 2;
    // First half: top → bottom on the +x face
    for (let i = 0; i < half; i++) {
      const u = i / Math.max(1, half - 1); // 0..1
      out.push({ x: 0, y: T * (1 - 2 * u), nx: 1, ny: 0 });
    }
    // Second half: bottom → top on the −x face
    for (let i = 0; i < K - half; i++) {
      const u = i / Math.max(1, K - half - 1);
      out.push({ x: 0, y: T * (-1 + 2 * u), nx: -1, ny: 0 });
    }
    return out;
  }

  R = Math.max(0, Math.min(R, Math.min(W, T)));

  // Perimeter as a piecewise curve, walked counter-clockwise starting from +x axis.
  // Segments: right-side (up), top-right corner, top side (left), top-left corner,
  // left side (down), bottom-left corner, bottom side (right), bottom-right corner.
  const sideY = 2 * (T - R); // length of vertical sides
  const sideX = 2 * (W - R); // length of horizontal sides
  const cornerLen = (Math.PI / 2) * R;
  const total = 2 * sideX + 2 * sideY + 4 * cornerLen;

  const out: { x: number; y: number; nx: number; ny: number }[] = new Array(K);
  for (let i = 0; i < K; i++) {
    let s = (i / K) * total;
    // Right side
    if (s < sideY) {
      const u = s / Math.max(1e-9, sideY); // 0..1 bottom→top
      out[i] = { x: W, y: -(T - R) + u * sideY, nx: 1, ny: 0 };
      continue;
    }
    s -= sideY;
    // Top-right corner: arc from (W, T-R) sweeping to (W-R, T)
    if (s < cornerLen) {
      const a = (s / Math.max(1e-9, cornerLen)) * (Math.PI / 2); // 0..π/2
      const cx = W - R;
      const cy = T - R;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      out[i] = { x: cx + R * nx, y: cy + R * ny, nx, ny };
      continue;
    }
    s -= cornerLen;
    // Top side
    if (s < sideX) {
      const u = s / Math.max(1e-9, sideX); // 0..1 right→left
      out[i] = { x: W - R - u * sideX, y: T, nx: 0, ny: 1 };
      continue;
    }
    s -= sideX;
    // Top-left corner: arc centered at (-W+R, T-R)
    if (s < cornerLen) {
      const a = Math.PI / 2 + (s / Math.max(1e-9, cornerLen)) * (Math.PI / 2); // π/2..π
      const cx = -W + R;
      const cy = T - R;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      out[i] = { x: cx + R * nx, y: cy + R * ny, nx, ny };
      continue;
    }
    s -= cornerLen;
    // Left side
    if (s < sideY) {
      const u = s / Math.max(1e-9, sideY); // top→bottom
      out[i] = { x: -W, y: T - R - u * sideY, nx: -1, ny: 0 };
      continue;
    }
    s -= sideY;
    // Bottom-left corner
    if (s < cornerLen) {
      const a = Math.PI + (s / Math.max(1e-9, cornerLen)) * (Math.PI / 2); // π..3π/2
      const cx = -W + R;
      const cy = -T + R;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      out[i] = { x: cx + R * nx, y: cy + R * ny, nx, ny };
      continue;
    }
    s -= cornerLen;
    // Bottom side
    if (s < sideX) {
      const u = s / Math.max(1e-9, sideX); // left→right
      out[i] = { x: -W + R + u * sideX, y: -T, nx: 0, ny: -1 };
      continue;
    }
    s -= sideX;
    // Bottom-right corner
    const a = (3 * Math.PI) / 2 + (s / Math.max(1e-9, cornerLen)) * (Math.PI / 2); // 3π/2..2π
    const cx = W - R;
    const cy = -T + R;
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    out[i] = { x: cx + R * nx, y: cy + R * ny, nx, ny };
  }
  return out;
}

/**
 * Build a smooth Catmull-Rom curve through the chain's Cα points, padded at the
 * ends with reflected ghost points so the first/last segment isn't shortened.
 */
function makeCurve(pts: THREE.Vector3[]): THREE.CatmullRomCurve3 | null {
  if (pts.length < 2) return null;
  const padded = [
    pts[0]
      .clone()
      .multiplyScalar(2)
      .sub(pts[1] ?? pts[0]),
    ...pts,
    pts[pts.length - 1]
      .clone()
      .multiplyScalar(2)
      .sub(pts[pts.length - 2] ?? pts[pts.length - 1]),
  ];
  return new THREE.CatmullRomCurve3(padded, false, "catmullrom", 0.5);
}

/** Read Cα positions for a chain into Vector3 array. */
function readChainPositions(chain: ChainBackbone, positions: Float32Array): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < chain.atomIndices.length; i++) {
    const a = chain.atomIndices[i] * 3;
    pts.push(new THREE.Vector3(positions[a], positions[a + 1], positions[a + 2]));
  }
  return pts;
}

/** Linear interpolation of cross-section parameters between two residues. */
function lerpProfile(a: CrossSection, b: CrossSection, t: number): CrossSection {
  return {
    halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
    halfThick: a.halfThick + (b.halfThick - a.halfThick) * t,
    cornerRadius: a.cornerRadius + (b.cornerRadius - a.cornerRadius) * t,
  };
}

/**
 * A single continuous ribbon mesh for one chain, plus the frame-invariant data
 * needed to refresh its vertex positions in place on each trajectory frame.
 *
 * Topology (index buffer), vertex colors, and the per-sample cross-section rings
 * depend only on the chain's Cα count and secondary-structure types — none of
 * which change between frames. Only the world-space vertex positions and normals
 * vary with the Cα coordinates, so playback recomputes just those two attributes
 * and re-uploads them, instead of allocating a fresh geometry every frame.
 */
interface ChainRibbon {
  mesh: THREE.Mesh;
  positionAttr: THREE.BufferAttribute;
  normalAttr: THREE.BufferAttribute;
  /** Cα atom indices into the flat positions array (chain backbone order). */
  atomIndices: Uint32Array;
  /** Precomputed cross-section ring per curve sample (frame-invariant). */
  rings: { x: number; y: number; nx: number; ny: number }[][];
  nSamples: number;
  K: number;
}

/**
 * Recompute the world-space position and normal of every ribbon vertex for a new
 * set of atom coordinates and flag the two attributes for re-upload. The index,
 * color, and ring data are left untouched because they do not depend on the frame.
 */
function fillRibbonPositionsNormals(ribbon: ChainRibbon, positions: Float32Array): void {
  const { atomIndices, rings, nSamples, K, positionAttr, normalAttr } = ribbon;

  const ca: THREE.Vector3[] = new Array(atomIndices.length);
  for (let i = 0; i < atomIndices.length; i++) {
    const a = atomIndices[i] * 3;
    ca[i] = new THREE.Vector3(positions[a], positions[a + 1], positions[a + 2]);
  }
  const curve = makeCurve(ca);
  if (!curve) return; // topology is fixed, so a ribbon that built once stays buildable

  const frames = curve.computeFrenetFrames(nSamples - 1, false);
  const posArr = positionAttr.array as Float32Array;
  const normArr = normalAttr.array as Float32Array;

  const vP = new THREE.Vector3();
  const vN = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  for (let s = 0; s < nSamples; s++) {
    const t = s / (nSamples - 1); // 0..1 along the curve
    curve.getPointAt(t, vP);
    // Frenet frames: one normal & binormal per segment endpoint, length = nSamples
    // (computeFrenetFrames(N) returns N+1 frames). Index by s directly.
    const N = frames.normals[s] ?? frames.normals[frames.normals.length - 1];
    const B = frames.binormals[s] ?? frames.binormals[frames.binormals.length - 1];
    vN.copy(N);
    vB.copy(B);

    const ring = rings[s];
    const base = s * K;
    for (let k = 0; k < K; k++) {
      const r = ring[k];
      // Position: curve(t) + r.x * N + r.y * B
      const px = vP.x + r.x * vN.x + r.y * vB.x;
      const py = vP.y + r.x * vN.y + r.y * vB.y;
      const pz = vP.z + r.x * vN.z + r.y * vB.z;

      // World-space outward normal: r.nx * N + r.ny * B (cross-section is locally flat in N,B plane).
      tmpA.copy(vN).multiplyScalar(r.nx);
      tmpB.copy(vB).multiplyScalar(r.ny);
      tmpA.add(tmpB);
      const nLen = tmpA.length() || 1;
      tmpA.divideScalar(nLen);

      const v3 = (base + k) * 3;
      posArr[v3] = px;
      posArr[v3 + 1] = py;
      posArr[v3 + 2] = pz;
      normArr[v3] = tmpA.x;
      normArr[v3 + 1] = tmpA.y;
      normArr[v3 + 2] = tmpA.z;
    }
  }

  positionAttr.needsUpdate = true;
  normalAttr.needsUpdate = true;
  // Vertices moved, so the cached bounding sphere would wrongly frustum-cull the
  // ribbon. Recompute it to match the new geometry.
  ribbon.mesh.geometry.computeBoundingSphere();
}

/**
 * Build a single continuous ribbon mesh for a chain by sweeping a parameterized
 * cross-section along the smoothed Cα backbone. SS-dependent cross-sections are
 * interpolated per-sample to give smooth tapers at boundaries.
 *
 * Returns a {@link ChainRibbon} carrying the mesh plus the frame-invariant data
 * (rings, colors baked into the geometry, index buffer) so subsequent frames can
 * update positions/normals in place via {@link fillRibbonPositionsNormals}.
 */
function buildChainRibbon(chain: ChainBackbone, positions: Float32Array): ChainRibbon | null {
  const ca = readChainPositions(chain, positions);
  if (ca.length < 2) return null;
  const curve = makeCurve(ca);
  if (!curve) return null;

  const { profiles, colors } = computeRibbonProfile(chain.ssTypes);

  // Total samples: SAMPLES_PER_RESIDUE between each adjacent residue pair, +1 for the final endpoint.
  const nResidues = ca.length;
  const nSamples = (nResidues - 1) * SAMPLES_PER_RESIDUE + 1;

  const K = CROSS_SECTION_POINTS;
  const totalVerts = nSamples * K;
  const positionsArr = new Float32Array(totalVerts * 3);
  const normalsArr = new Float32Array(totalVerts * 3);
  const colorsArr = new Float32Array(totalVerts * 3);

  // Each adjacent pair of cross-section rings gets K quads = 2K triangles.
  const indicesArr = new Uint32Array((nSamples - 1) * K * 6);

  // Precompute the frame-invariant cross-section rings and bake vertex colors:
  // both depend only on the per-sample interpolated SS profile, not on positions.
  const rings: { x: number; y: number; nx: number; ny: number }[][] = new Array(nSamples);
  const tmpColor = new THREE.Color();
  for (let s = 0; s < nSamples; s++) {
    const t = s / (nSamples - 1); // 0..1 along the curve
    // Determine which residues we're between and the local interpolation factor.
    const fResidue = t * (nResidues - 1);
    const i0 = Math.min(nResidues - 1, Math.floor(fResidue));
    const i1 = Math.min(nResidues - 1, i0 + 1);
    const lerpT = fResidue - i0;
    const cs = lerpProfile(profiles[i0], profiles[i1], lerpT);
    rings[s] = buildCrossSection(K, cs.halfWidth, cs.halfThick, cs.cornerRadius);

    // Vertex color: interpolated between residue colors.
    tmpColor.copy(colors[i0]).lerp(colors[i1], lerpT);
    const base = s * K;
    for (let k = 0; k < K; k++) {
      const v3 = (base + k) * 3;
      colorsArr[v3] = tmpColor.r;
      colorsArr[v3 + 1] = tmpColor.g;
      colorsArr[v3 + 2] = tmpColor.b;
    }
  }

  // Stitch consecutive rings: each pair of rings (s, s+1) gives K quads.
  // Vertex k of ring s connects to vertex k of ring s+1 and (k+1)%K.
  let idx = 0;
  for (let s = 0; s < nSamples - 1; s++) {
    const baseA = s * K;
    const baseB = (s + 1) * K;
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const a0 = baseA + k;
      const a1 = baseA + k1;
      const b0 = baseB + k;
      const b1 = baseB + k1;
      // Two triangles per quad, outward-facing (CCW when viewed from outside).
      indicesArr[idx++] = a0;
      indicesArr[idx++] = b0;
      indicesArr[idx++] = a1;
      indicesArr[idx++] = a1;
      indicesArr[idx++] = b0;
      indicesArr[idx++] = b1;
    }
  }

  const geo = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positionsArr, 3);
  const normalAttr = new THREE.BufferAttribute(normalsArr, 3);
  // Positions/normals are rewritten every trajectory frame; hint the driver.
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  normalAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", positionAttr);
  geo.setAttribute("normal", normalAttr);
  geo.setAttribute("color", new THREE.BufferAttribute(colorsArr, 3));
  geo.setIndex(new THREE.BufferAttribute(indicesArr, 1));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.0,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });

  const ribbon: ChainRibbon = {
    mesh: new THREE.Mesh(geo, mat),
    positionAttr,
    normalAttr,
    atomIndices: chain.atomIndices,
    rings,
    nSamples,
    K,
  };
  // Fill the initial frame's positions/normals through the shared path.
  fillRibbonPositionsNormals(ribbon, positions);
  return ribbon;
}

// ─── CartoonRenderer class ────────────────────────────────────────────────────

export class CartoonRenderer {
  /** The THREE.Group containing all cartoon meshes; add to scene. */
  readonly mesh: THREE.Group;

  private snapshot: Snapshot | null = null;
  private chains: ChainBackbone[] = [];
  private ribbons: ChainRibbon[] = [];
  /** The topology changed since the ribbons were last built. */
  private dirty = false;
  /** Positions of the latest frame, when they differ from the snapshot's. */
  private latestPositions: Float32Array | null = null;
  /** A frame arrived while hidden, so the ribbons are out of date. */
  private positionsStale = false;

  constructor() {
    this.mesh = new THREE.Group();
    this.mesh.visible = false;
  }

  /**
   * Load a new snapshot (topology). The ribbons are built now if the cartoon is
   * visible, otherwise when it is next shown: a hidden cartoon costs ~20 KB
   * per residue that nobody would see.
   */
  loadSnapshot(snapshot: Snapshot): void {
    if (snapshot !== this.snapshot) this.latestPositions = null;
    this.snapshot = snapshot;
    this.dirty = true;
    if (this.mesh.visible) this._rebuild();
    else this.dispose(); // the previous structure's ribbons are stale
  }

  /**
   * Update positions for a new trajectory frame (topology unchanged).
   *
   * Rewrites each ribbon's position/normal attributes in place rather than
   * disposing and reallocating geometry — the index buffer, vertex colors, and
   * cross-section rings are frame-invariant. While hidden, the frame is only
   * remembered and applied when the cartoon is shown.
   */
  updatePositions(positions: Float32Array): void {
    if (!this.snapshot) return;
    this.latestPositions = positions;
    if (this.dirty || this.ribbons.length === 0) return;
    if (!this.mesh.visible) {
      this.positionsStale = true;
      return;
    }
    this._fillPositions(positions);
  }

  private _fillPositions(positions: Float32Array): void {
    this.positionsStale = false;
    perfMark("megane:cartoon:update:start");
    for (const ribbon of this.ribbons) {
      fillRibbonPositionsNormals(ribbon, positions);
    }
    perfMark("megane:cartoon:update:end");
    perfMeasure(
      "megane:cartoon:update",
      "megane:cartoon:update:start",
      "megane:cartoon:update:end",
    );
  }

  private _rebuild(): void {
    const snapshot = this.snapshot!;
    const positions = this.latestPositions ?? snapshot.positions;
    this.dirty = false;
    this.positionsStale = false;
    this._disposeChildren();
    this.mesh.clear();
    this.ribbons = [];
    this.chains = extractChainBackbones(snapshot);

    for (const chain of this.chains) {
      const ribbon = buildChainRibbon(chain, positions);
      if (ribbon) {
        this.ribbons.push(ribbon);
        this.mesh.add(ribbon.mesh);
      }
    }
  }

  /** Show or hide the cartoon, building or refreshing the ribbons on show. */
  setVisible(v: boolean): void {
    if (v && this.snapshot) {
      if (this.dirty) this._rebuild();
      else if (this.positionsStale) this._fillPositions(this.latestPositions!);
    }
    this.mesh.visible = v;
  }

  /** Free all Three.js GPU resources. */
  dispose(): void {
    this._disposeChildren();
    this.mesh.clear();
    this.ribbons = [];
  }

  private _disposeChildren(): void {
    this.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          (obj.material as THREE.Material).dispose();
        }
      }
    });
  }
}
