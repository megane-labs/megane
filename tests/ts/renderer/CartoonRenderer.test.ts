import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  extractChainBackbones,
  buildSegments,
  buildCrossSection,
  computeRibbonProfile,
  CartoonRenderer,
  SS_COIL,
  SS_HELIX,
  SS_SHEET,
} from "@/renderer/CartoonRenderer";
import type { Snapshot } from "@/types";

// Minimal Snapshot factory for testing — only fields used by CartoonRenderer are needed.
function makeSnapshot(
  caIndices: number[],
  caChainIds: number[],
  caResNums: number[],
  caSsType: number[],
): Snapshot {
  return {
    nAtoms: caIndices.length * 2, // not relevant for these tests
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(caIndices.length * 2 * 3),
    elements: new Uint8Array(caIndices.length * 2),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    caIndices: new Uint32Array(caIndices),
    caChainIds: new Uint8Array(caChainIds),
    caResNums: new Uint32Array(caResNums),
    caSsType: new Uint8Array(caSsType),
  };
}

describe("extractChainBackbones", () => {
  it("returns empty array for snapshot with no Cα data", () => {
    const snap: Snapshot = {
      nAtoms: 1,
      nBonds: 0,
      nFileBonds: 0,
      positions: new Float32Array(3),
      elements: new Uint8Array(1),
      bonds: new Uint32Array(0),
      bondOrders: null,
      box: null,
    };
    expect(extractChainBackbones(snap)).toEqual([]);
  });

  it("returns empty array for snapshot with empty caIndices", () => {
    const snap = makeSnapshot([], [], [], []);
    expect(extractChainBackbones(snap)).toEqual([]);
  });

  it("groups Cα atoms by chain ID", () => {
    // Chain A: resNums 1,2; Chain B: resNum 1
    const snap = makeSnapshot(
      [0, 1, 2],
      [65, 65, 66], // A=65, B=66
      [1, 2, 1],
      [SS_COIL, SS_COIL, SS_COIL],
    );
    const chains = extractChainBackbones(snap);
    expect(chains.length).toBe(2);
    const chainA = chains.find((c) => c.chainId === 65)!;
    const chainB = chains.find((c) => c.chainId === 66)!;
    expect(chainA).toBeDefined();
    expect(chainB).toBeDefined();
    expect(chainA.atomIndices.length).toBe(2);
    expect(chainB.atomIndices.length).toBe(1);
  });

  it("sorts Cα atoms by residue number within each chain", () => {
    // Atoms provided out of order (resNum 3, 1, 2)
    const snap = makeSnapshot(
      [10, 20, 30], // atom indices in positions array
      [65, 65, 65], // all chain A
      [3, 1, 2], // residue numbers — unsorted
      [SS_COIL, SS_HELIX, SS_SHEET],
    );
    const [chain] = extractChainBackbones(snap);
    // After sorting by resNum: residue 1 (atomIndex 20), 2 (atomIndex 30), 3 (atomIndex 10)
    expect(Array.from(chain.atomIndices)).toEqual([20, 30, 10]);
    expect(Array.from(chain.ssTypes)).toEqual([SS_HELIX, SS_SHEET, SS_COIL]);
  });

  it("preserves SS types in sorted order", () => {
    const snap = makeSnapshot(
      [0, 1, 2, 3],
      [65, 65, 65, 65],
      [4, 2, 1, 3],
      [SS_SHEET, SS_HELIX, SS_COIL, SS_HELIX],
    );
    const [chain] = extractChainBackbones(snap);
    // Sorted by resNum: 1→coil, 2→helix, 3→helix, 4→sheet
    expect(Array.from(chain.ssTypes)).toEqual([SS_COIL, SS_HELIX, SS_HELIX, SS_SHEET]);
  });
});

describe("buildSegments", () => {
  it("returns empty array for empty input", () => {
    expect(buildSegments(new Uint8Array(0))).toEqual([]);
  });

  it("single element produces one segment", () => {
    const segs = buildSegments(new Uint8Array([SS_HELIX]));
    expect(segs.length).toBe(1);
    expect(segs[0]).toEqual({ caSliceStart: 0, caSliceEnd: 1, ssType: SS_HELIX });
  });

  it("all same type produces one segment spanning all", () => {
    const segs = buildSegments(new Uint8Array([SS_COIL, SS_COIL, SS_COIL]));
    expect(segs.length).toBe(1);
    expect(segs[0]).toEqual({ caSliceStart: 0, caSliceEnd: 3, ssType: SS_COIL });
  });

  it("transitions produce separate segments", () => {
    // coil(2), helix(3), sheet(2)
    const types = new Uint8Array([
      SS_COIL,
      SS_COIL,
      SS_HELIX,
      SS_HELIX,
      SS_HELIX,
      SS_SHEET,
      SS_SHEET,
    ]);
    const segs = buildSegments(types);
    expect(segs.length).toBe(3);
    expect(segs[0]).toEqual({ caSliceStart: 0, caSliceEnd: 2, ssType: SS_COIL });
    expect(segs[1]).toEqual({ caSliceStart: 2, caSliceEnd: 5, ssType: SS_HELIX });
    expect(segs[2]).toEqual({ caSliceStart: 5, caSliceEnd: 7, ssType: SS_SHEET });
  });

  it("alternating types produce a segment per residue", () => {
    const types = new Uint8Array([SS_COIL, SS_HELIX, SS_COIL, SS_HELIX]);
    const segs = buildSegments(types);
    expect(segs.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(segs[i].caSliceStart).toBe(i);
      expect(segs[i].caSliceEnd).toBe(i + 1);
    }
  });

  it("all helix then sheet transition", () => {
    const types = new Uint8Array([SS_HELIX, SS_HELIX, SS_SHEET, SS_SHEET]);
    const segs = buildSegments(types);
    expect(segs.length).toBe(2);
    expect(segs[0].ssType).toBe(SS_HELIX);
    expect(segs[1].ssType).toBe(SS_SHEET);
  });
});

// ─── CartoonRenderer class ────────────────────────────────────────────────────

/**
 * Build a snapshot whose Cα atoms form a straight line along the X axis.
 * Positions array has 2 atoms per Cα to keep index math simple.
 */
function makeLinearSnapshot(nCa: number, ssType = SS_COIL): Snapshot {
  const positions = new Float32Array(nCa * 3);
  for (let i = 0; i < nCa; i++) {
    positions[i * 3] = i * 3.8; // typical Cα–Cα distance ~3.8 Å
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
  }
  return {
    nAtoms: nCa,
    nBonds: 0,
    nFileBonds: 0,
    positions,
    elements: new Uint8Array(nCa),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    caIndices: new Uint32Array(Array.from({ length: nCa }, (_, i) => i)),
    caChainIds: new Uint8Array(nCa).fill(65), // chain 'A'
    caResNums: new Uint32Array(Array.from({ length: nCa }, (_, i) => i + 1)),
    caSsType: new Uint8Array(nCa).fill(ssType),
  };
}

/** A visible renderer, which builds its ribbons as soon as it is loaded. */
function shownCartoon(): CartoonRenderer {
  const cr = new CartoonRenderer();
  cr.setVisible(true);
  return cr;
}

describe("CartoonRenderer (built on demand)", () => {
  it("builds nothing while hidden and builds on show", () => {
    const cr = new CartoonRenderer();
    cr.loadSnapshot(makeLinearSnapshot(5, SS_COIL));
    expect(cr.mesh.children.length).toBe(0);
    cr.setVisible(true);
    expect(cr.mesh.children.length).toBeGreaterThan(0);
  });

  it("builds from the latest frame when shown mid-trajectory", () => {
    const snap = makeLinearSnapshot(6, SS_COIL);
    const shifted = new Float32Array(snap.positions);
    for (let i = 0; i < 6; i++) shifted[i * 3 + 1] += 50;

    const lazy = new CartoonRenderer();
    lazy.loadSnapshot(snap);
    lazy.updatePositions(shifted);
    lazy.setVisible(true);

    const eager = shownCartoon();
    eager.loadSnapshot(snap);
    eager.updatePositions(shifted);

    const pos = (cr: CartoonRenderer): number[] =>
      Array.from(
        (
          (cr.mesh.children[0] as THREE.Mesh).geometry.getAttribute(
            "position",
          ) as THREE.BufferAttribute
        ).array as Float32Array,
      );
    expect(pos(lazy)).toEqual(pos(eager));
  });

  it("applies frames that arrived while hidden when shown again", () => {
    const snap = makeLinearSnapshot(6, SS_COIL);
    const cr = shownCartoon();
    cr.loadSnapshot(snap);
    const attr = (cr.mesh.children[0] as THREE.Mesh).geometry.getAttribute("position");
    const before = Array.from(attr.array as Float32Array);

    cr.setVisible(false);
    const shifted = new Float32Array(snap.positions);
    for (let i = 0; i < 6; i++) shifted[i * 3 + 2] += 20;
    cr.updatePositions(shifted);
    // Hidden: the ribbons are left alone...
    expect(Array.from(attr.array as Float32Array)).toEqual(before);
    // ...and catch up on show.
    cr.setVisible(true);
    expect(Array.from(attr.array as Float32Array)).not.toEqual(before);
  });

  it("drops the previous structure's ribbons when a new one loads hidden", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(5, SS_COIL));
    expect(cr.mesh.children.length).toBeGreaterThan(0);
    cr.setVisible(false);
    cr.loadSnapshot(makeLinearSnapshot(4, SS_HELIX));
    expect(cr.mesh.children.length).toBe(0);
  });
});

describe("CartoonRenderer", () => {
  it("constructor creates a hidden group", () => {
    const cr = new CartoonRenderer();
    expect(cr.mesh).toBeInstanceOf(THREE.Group);
    expect(cr.mesh.visible).toBe(false);
  });

  it("setVisible toggles group visibility", () => {
    const cr = new CartoonRenderer();
    cr.setVisible(true);
    expect(cr.mesh.visible).toBe(true);
    cr.setVisible(false);
    expect(cr.mesh.visible).toBe(false);
  });

  it("loadSnapshot with no Cα data produces empty mesh", () => {
    const cr = new CartoonRenderer();
    const snap: Snapshot = {
      nAtoms: 1,
      nBonds: 0,
      nFileBonds: 0,
      positions: new Float32Array(3),
      elements: new Uint8Array(1),
      bonds: new Uint32Array(0),
      bondOrders: null,
      box: null,
    };
    cr.loadSnapshot(snap);
    expect(cr.mesh.children.length).toBe(0);
  });

  it("loadSnapshot with coil Cα atoms adds mesh children", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(5, SS_COIL));
    expect(cr.mesh.children.length).toBeGreaterThan(0);
  });

  it("loadSnapshot with helix Cα atoms adds mesh children", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(6, SS_HELIX));
    expect(cr.mesh.children.length).toBeGreaterThan(0);
  });

  it("loadSnapshot with sheet Cα atoms adds mesh children", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(4, SS_SHEET));
    expect(cr.mesh.children.length).toBeGreaterThan(0);
  });

  it("loadSnapshot with mixed SS types renders all segment types", () => {
    const snap = makeSnapshot(
      [0, 1, 2, 3, 4, 5],
      [65, 65, 65, 65, 65, 65],
      [1, 2, 3, 4, 5, 6],
      [SS_COIL, SS_COIL, SS_HELIX, SS_HELIX, SS_SHEET, SS_SHEET],
    );
    // Need matching positions for 6 atoms
    const positions = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i++) positions[i * 3] = i * 3.8;
    const fullSnap = { ...snap, positions };
    const cr = shownCartoon();
    cr.loadSnapshot(fullSnap);
    expect(cr.mesh.children.length).toBeGreaterThan(0);
  });

  it("updatePositions rebuilds geometry for a new frame", () => {
    const cr = shownCartoon();
    const snap = makeLinearSnapshot(4, SS_COIL);
    cr.loadSnapshot(snap);
    const before = cr.mesh.children.length;

    const newPositions = new Float32Array(snap.positions.length);
    for (let i = 0; i < 4; i++) newPositions[i * 3] = i * 4.0;
    cr.updatePositions(newPositions);
    expect(cr.mesh.children.length).toBe(before);
  });

  it("updatePositions does nothing when no snapshot loaded", () => {
    const cr = new CartoonRenderer();
    cr.updatePositions(new Float32Array(12));
    expect(cr.mesh.children.length).toBe(0);
  });

  it("updatePositions updates geometry in place without reallocating it", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(6, SS_COIL));
    const mesh = cr.mesh.children[0] as THREE.Mesh;
    const geoBefore = mesh.geometry;
    const posAttrBefore = mesh.geometry.getAttribute("position");

    const newPositions = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i++) newPositions[i * 3] = i * 4.2;
    cr.updatePositions(newPositions);

    const meshAfter = cr.mesh.children[0] as THREE.Mesh;
    // Same mesh, same geometry, same underlying attribute objects → in-place.
    expect(meshAfter).toBe(mesh);
    expect(meshAfter.geometry).toBe(geoBefore);
    expect(meshAfter.geometry.getAttribute("position")).toBe(posAttrBefore);
  });

  it("updatePositions moves vertices to reflect new coordinates", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(6, SS_COIL));
    const posAttr = (cr.mesh.children[0] as THREE.Mesh).geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const firstVertexX = posAttr.getX(0);
    const versionBefore = posAttr.version;

    // Shift the whole chain by a large amount along +Y.
    const newPositions = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i++) {
      newPositions[i * 3] = i * 3.8;
      newPositions[i * 3 + 1] = 50;
    }
    cr.updatePositions(newPositions);

    // Positions were rewritten and flagged for GPU re-upload (needsUpdate=true
    // is a write-only setter that bumps the attribute version).
    expect(posAttr.version).toBeGreaterThan(versionBefore);
    // The ribbon followed the backbone into the shifted region.
    let maxY = -Infinity;
    for (let v = 0; v < posAttr.count; v++) maxY = Math.max(maxY, posAttr.getY(v));
    expect(maxY).toBeGreaterThan(40);
    // And the X coordinate of the seam vertex is unchanged (chain only moved in Y).
    expect(posAttr.getX(0)).toBeCloseTo(firstVertexX, 3);
  });

  it("updatePositions preserves frame-invariant vertex colors", () => {
    const snap = makeSnapshot(
      [0, 1, 2, 3, 4, 5],
      [65, 65, 65, 65, 65, 65],
      [1, 2, 3, 4, 5, 6],
      [SS_COIL, SS_HELIX, SS_HELIX, SS_SHEET, SS_SHEET, SS_COIL],
    );
    const positions = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i++) positions[i * 3] = i * 3.8;
    const cr = shownCartoon();
    cr.loadSnapshot({ ...snap, positions });
    const colorAttr = (cr.mesh.children[0] as THREE.Mesh).geometry.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    const colorsBefore = Float32Array.from(colorAttr.array as Float32Array);

    const moved = new Float32Array(positions);
    for (let i = 0; i < 6; i++) moved[i * 3 + 2] = i * 1.5; // add a Z zig-zag
    cr.updatePositions(moved);

    expect(Array.from(colorAttr.array as Float32Array)).toEqual(Array.from(colorsBefore));
  });

  it("updatePositions refreshes the geometry bounding sphere", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(6, SS_COIL));
    const geo = (cr.mesh.children[0] as THREE.Mesh).geometry;
    const centerBefore = geo.boundingSphere!.center.clone();

    // Translate the whole chain far along +X.
    const newPositions = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i++) newPositions[i * 3] = 1000 + i * 3.8;
    cr.updatePositions(newPositions);

    expect(geo.boundingSphere).not.toBeNull();
    expect(geo.boundingSphere!.center.x).toBeGreaterThan(centerBefore.x + 500);
  });

  it("dispose clears mesh children and frees geometry", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(5, SS_COIL));
    expect(cr.mesh.children.length).toBeGreaterThan(0);
    cr.dispose();
    expect(cr.mesh.children.length).toBe(0);
  });

  it("single Cα atom produces no geometry (need ≥2 pts for curve)", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(1, SS_COIL));
    // With only 1 atom, makeCurve returns null → no meshes added
    expect(cr.mesh.children.length).toBe(0);
  });

  it("loadSnapshot replaces previous geometry on re-call", () => {
    const cr = shownCartoon();
    cr.loadSnapshot(makeLinearSnapshot(4, SS_COIL));
    const first = cr.mesh.children.length;
    cr.loadSnapshot(makeLinearSnapshot(4, SS_HELIX));
    // Children should be rebuilt, not accumulated
    expect(cr.mesh.children.length).toBeGreaterThan(0);
    expect(cr.mesh.children.length).toBeLessThanOrEqual(first + 5);
  });

  it("renders one continuous mesh per chain", () => {
    // Two chains × one mesh each = 2 children.
    const snap = makeSnapshot(
      [0, 1, 2, 3, 4, 5],
      [65, 65, 65, 66, 66, 66], // chain A=65, chain B=66
      [1, 2, 3, 1, 2, 3],
      [SS_HELIX, SS_HELIX, SS_HELIX, SS_SHEET, SS_SHEET, SS_SHEET],
    );
    const positions = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i++) positions[i * 3] = i * 3.8;
    const cr = shownCartoon();
    cr.loadSnapshot({ ...snap, positions });
    expect(cr.mesh.children.length).toBe(2);
    // Each child is a single mesh with vertex colors enabled.
    for (const child of cr.mesh.children) {
      expect(child).toBeInstanceOf(THREE.Mesh);
      const mesh = child as THREE.Mesh;
      expect(mesh.geometry.getAttribute("color")).toBeDefined();
      expect(mesh.geometry.getAttribute("position")).toBeDefined();
      expect(mesh.geometry.getAttribute("normal")).toBeDefined();
      expect(mesh.geometry.getIndex()).not.toBeNull();
    }
  });
});

// ─── buildCrossSection ────────────────────────────────────────────────────────

describe("buildCrossSection", () => {
  it("returns K points with normalized outward normals", () => {
    const K = 16;
    const ring = buildCrossSection(K, 1.0, 0.2, 0.1);
    expect(ring.length).toBe(K);
    for (const p of ring) {
      const len = Math.hypot(p.nx, p.ny);
      expect(len).toBeGreaterThan(0.95);
      expect(len).toBeLessThan(1.05);
    }
  });

  it("produces a circular ring when W = T = R (coil profile)", () => {
    const K = 24;
    const r = 0.3;
    const ring = buildCrossSection(K, r, r, r);
    for (const p of ring) {
      // Every point lies on a circle of radius r centered at origin.
      const dist = Math.hypot(p.x, p.y);
      expect(dist).toBeGreaterThan(r * 0.95);
      expect(dist).toBeLessThan(r * 1.05);
    }
  });

  it("clamps cornerRadius greater than min(W, T)", () => {
    // R is huge but should be clamped to min(W, T) = 0.2; should not throw or NaN.
    const ring = buildCrossSection(16, 1.0, 0.2, 5.0);
    expect(ring.length).toBe(16);
    for (const p of ring) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("zero cornerRadius produces a sharp rectangle", () => {
    const ring = buildCrossSection(20, 1.0, 0.5, 0);
    expect(ring.length).toBe(20);
    // Every point should lie on the rectangle border (max(|x|/W, |y|/T) ≈ 1)
    for (const p of ring) {
      const m = Math.max(Math.abs(p.x) / 1.0, Math.abs(p.y) / 0.5);
      expect(m).toBeGreaterThan(0.99);
      expect(m).toBeLessThan(1.01);
    }
  });

  it("collapses to a knife edge when W ≈ 0 (arrow tip)", () => {
    const K = 12;
    const ring = buildCrossSection(K, 0, 0.2, 0);
    expect(ring.length).toBe(K);
    // All x coordinates are zero; normals split evenly between +x and −x sides.
    let plus = 0;
    let minus = 0;
    for (const p of ring) {
      expect(Math.abs(p.x)).toBeLessThan(1e-9);
      if (p.nx > 0) plus++;
      else if (p.nx < 0) minus++;
    }
    expect(plus).toBe(K / 2);
    expect(minus).toBe(K / 2);
  });

  it("samples are spread around the perimeter (no collapsed cluster)", () => {
    const K = 16;
    const ring = buildCrossSection(K, 1.0, 0.2, 0.1);
    // The unique angles (atan2) should span the full circle.
    const angles = ring.map((p) => Math.atan2(p.ny, p.nx)).sort((a, b) => a - b);
    // Maximum gap between consecutive sorted angles (with wrap) should be < π/2.
    let maxGap = 0;
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
      maxGap = Math.max(maxGap, b - a);
    }
    // No half-perimeter is missing; samples don't pile up on a single side.
    expect(maxGap).toBeLessThan(Math.PI);
  });
});

// ─── computeRibbonProfile ─────────────────────────────────────────────────────

describe("computeRibbonProfile", () => {
  it("produces one profile per residue with reasonable defaults", () => {
    const ss = new Uint8Array([SS_COIL, SS_HELIX, SS_SHEET]);
    const { profiles, colors } = computeRibbonProfile(ss);
    expect(profiles.length).toBe(3);
    expect(colors.length).toBe(3);
    // Coil should be narrow & roughly square; helix and sheet should be wider than coil.
    expect(profiles[0].halfWidth).toBeLessThan(0.5);
    expect(profiles[1].halfWidth).toBeGreaterThan(profiles[0].halfWidth);
    expect(profiles[2].halfWidth).toBeGreaterThan(profiles[0].halfWidth);
  });

  it("applies arrow profile to the last 2 residues of a sheet run (length ≥ 2)", () => {
    // coil, sheet × 4, coil
    const ss = new Uint8Array([SS_COIL, SS_SHEET, SS_SHEET, SS_SHEET, SS_SHEET, SS_COIL]);
    const { profiles } = computeRibbonProfile(ss);
    // Indices 1, 2: regular sheet; index 3: arrow base (wide); index 4: tip (zero width)
    expect(profiles[1].halfWidth).toBeGreaterThan(0.5);
    expect(profiles[1].halfWidth).toBeLessThan(1.5);
    expect(profiles[3].halfWidth).toBeGreaterThan(profiles[1].halfWidth);
    expect(profiles[4].halfWidth).toBe(0);
  });

  it("does not modify a 1-residue sheet (no arrow)", () => {
    // coil, sheet, coil — sheet run of length 1
    const ss = new Uint8Array([SS_COIL, SS_SHEET, SS_COIL]);
    const { profiles } = computeRibbonProfile(ss);
    // Single sheet residue keeps the regular sheet width (not collapsed to tip)
    expect(profiles[1].halfWidth).toBeGreaterThan(0.5);
  });

  it("handles a sheet run that ends at the chain terminus", () => {
    const ss = new Uint8Array([SS_COIL, SS_SHEET, SS_SHEET, SS_SHEET]);
    const { profiles } = computeRibbonProfile(ss);
    // Last 2 residues become arrow base + tip
    expect(profiles[2].halfWidth).toBeGreaterThan(profiles[1].halfWidth);
    expect(profiles[3].halfWidth).toBe(0);
  });

  it("handles multiple sheet runs independently", () => {
    // Two β-strands separated by a helix.
    const ss = new Uint8Array([SS_SHEET, SS_SHEET, SS_SHEET, SS_HELIX, SS_SHEET, SS_SHEET]);
    const { profiles } = computeRibbonProfile(ss);
    // First strand arrow tip at index 2
    expect(profiles[2].halfWidth).toBe(0);
    // Helix profile in the middle
    expect(profiles[3].halfWidth).toBeGreaterThan(0.5);
    // Second strand arrow tip at index 5
    expect(profiles[5].halfWidth).toBe(0);
  });

  it("handles all-coil input without errors", () => {
    const ss = new Uint8Array([SS_COIL, SS_COIL, SS_COIL]);
    const { profiles, colors } = computeRibbonProfile(ss);
    expect(profiles.length).toBe(3);
    expect(colors.length).toBe(3);
    for (const p of profiles) {
      expect(p.halfWidth).toBeGreaterThan(0);
    }
  });

  it("handles empty input", () => {
    const { profiles, colors } = computeRibbonProfile(new Uint8Array(0));
    expect(profiles.length).toBe(0);
    expect(colors.length).toBe(0);
  });
});
