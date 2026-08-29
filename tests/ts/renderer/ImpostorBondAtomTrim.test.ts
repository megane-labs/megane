/**
 * Atom-radius plumbing behind the bond shader's CSG union trim.
 *
 * The bond impostor draws each cylinder centre-to-centre, so its ends are
 * buried inside the endpoint spheres. The fragment shader discards the buried
 * part by testing the hit point against both endpoint spheres, which means it
 * needs the radius of the ball the atom impostor is actually drawing. That
 * radius travels as a per-atom value in the alpha channel of the bond mesh's
 * position texture times a global `uAtomRadiusScale` uniform, both fed by
 * `ImpostorAtomMesh.setRadiusSink`. The split keeps the atom mesh's O(1) global
 * scale / opacity updates O(1) on the bond side too.
 *
 * These tests cover the CPU side of that path: what radius the atom mesh
 * reports for a given styling, that every restyle republishes it, and that the
 * bond mesh keeps it in the texture across per-frame position updates and
 * topology rebuilds.
 */

import { describe, it, expect } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import { bondVertexShader, bondFragmentShader } from "@/renderer/shaders";
import { BALL_STICK_ATOM_SCALE, LICORICE_RADIUS, getRadius } from "@/constants";
import type { Snapshot } from "@/types";

/** Carbon (Z=6) — Oxygen (Z=8), one single bond, 1.5 Å apart along x. */
function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 1.5, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
  } as Snapshot;
}

/**
 * Extended snapshot in the shape `updateBondsExt` builds for PBC: two real
 * atoms plus one ghost image appended past the real-atom range.
 */
function makeGhostSnapshot(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    positions: new Float32Array([0, 0, 0, 1.5, 0, 0, 3.0, 0, 0]),
    elements: new Uint8Array([6, 8, 6]),
    bonds: new Uint32Array([0, 1, 1, 2]),
    bondOrders: null,
  } as Snapshot;
}

/** Alpha channel of the bond mesh's position texture = per-atom trim radius. */
function texRadii(mesh: ImpostorBondMesh, n: number): number[] {
  const data = (mesh as unknown as { positionTexData: Float32Array }).positionTexData;
  return Array.from({ length: n }, (_, i) => data[i * 4 + 3]);
}

function atomRadiusScale(mesh: ImpostorBondMesh): number {
  return (mesh as unknown as { bondMaterial: { uniforms: Record<string, { value: number }> } })
    .bondMaterial.uniforms.uAtomRadiusScale.value;
}

function texPositions(mesh: ImpostorBondMesh, n: number): number[] {
  const data = (mesh as unknown as { positionTexData: Float32Array }).positionTexData;
  return Array.from({ length: n * 3 }, (_, k) => data[Math.floor(k / 3) * 4 + (k % 3)]);
}

const C_RADIUS = getRadius(6) * BALL_STICK_ATOM_SCALE;
const O_RADIUS = getRadius(8) * BALL_STICK_ATOM_SCALE;

describe("ImpostorAtomMesh.getBaseRadii / getRadiusScale", () => {
  it("reports the per-element ball-and-stick radii by default", () => {
    const mesh = new ImpostorAtomMesh(8);
    mesh.loadSnapshot(makeSnapshot());

    const r = mesh.getBaseRadii();
    expect(r.length).toBe(2);
    expect(r[0]).toBeCloseTo(C_RADIUS, 6);
    expect(r[1]).toBeCloseTo(O_RADIUS, 6);
    expect(mesh.getRadiusScale()).toBe(1);
  });

  it("keeps the global scale multiplier out of the per-atom array", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setScale(2.5, snap);

    // Global scale rides the uniform, so a slider drag stays O(1) instead of
    // rewriting one float per atom.
    const r = mesh.getBaseRadii();
    expect(r[0]).toBeCloseTo(C_RADIUS, 6);
    expect(mesh.getRadiusScale()).toBe(2.5);
  });

  it("folds in per-atom scale overrides", () => {
    const mesh = new ImpostorAtomMesh(8);
    mesh.loadSnapshot(makeSnapshot());
    mesh.setScaleOverrides(new Float32Array([0.5, 3.0]));

    const r = mesh.getBaseRadii();
    expect(r[0]).toBeCloseTo(C_RADIUS * 0.5, 6);
    expect(r[1]).toBeCloseTo(O_RADIUS * 3.0, 6);
  });

  it("follows the licorice uniform radius", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setUniformRadius(LICORICE_RADIUS, snap);

    const r = mesh.getBaseRadii();
    expect(r[0]).toBeCloseTo(LICORICE_RADIUS, 6);
    expect(r[1]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("reports 0 for atoms hidden by a representation", () => {
    const mesh = new ImpostorAtomMesh(8);
    mesh.loadSnapshot(makeSnapshot());
    mesh.setHiddenMask(new Uint8Array([1, 0]));

    const r = mesh.getBaseRadii();
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(O_RADIUS, 6);
  });

  it("reports scale 0 when the atoms are faded out entirely", () => {
    const mesh = new ImpostorAtomMesh(8);
    mesh.loadSnapshot(makeSnapshot());
    // A fully transparent ball draws nothing, so trimming its bonds against it
    // would just punch gaps into the sticks.
    mesh.setOpacity(0);
    expect(mesh.getRadiusScale()).toBe(0);

    mesh.setOpacity(0.4);
    expect(mesh.getRadiusScale()).toBe(1);
    const faded = mesh.getBaseRadii();
    expect(faded[0]).toBeCloseTo(C_RADIUS, 6);
    expect(faded[1]).toBeCloseTo(O_RADIUS, 6);
  });

  it("reports 0 for a per-atom opacity override of 0", () => {
    const mesh = new ImpostorAtomMesh(8);
    mesh.loadSnapshot(makeSnapshot());
    mesh.setOpacityOverrides(new Float32Array([0, 0.2]));

    const r = mesh.getBaseRadii();
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(O_RADIUS, 6);
  });
});

describe("ImpostorAtomMesh.setRadiusSink", () => {
  interface Push {
    radii: number[] | null;
    scale: number;
  }

  function trackedMesh() {
    const mesh = new ImpostorAtomMesh(8);
    const seen: Push[] = [];
    mesh.setRadiusSink((radii, scale) => seen.push({ radii: radii && Array.from(radii), scale }));
    return { mesh, seen };
  }

  it("publishes immediately on subscribe", () => {
    const mesh = new ImpostorAtomMesh(8);
    mesh.loadSnapshot(makeSnapshot());
    const seen: Push[] = [];
    mesh.setRadiusSink((radii, scale) => seen.push({ radii: radii && Array.from(radii), scale }));

    expect(seen).toHaveLength(1);
    expect(seen[0].radii![0]).toBeCloseTo(C_RADIUS, 6);
    expect(seen[0].scale).toBe(1);
  });

  it("republishes on every restyle so no call site has to remember", () => {
    const { mesh, seen } = trackedMesh();
    const snap = makeSnapshot();

    const after = (fn: () => void) => {
      const before = seen.length;
      fn();
      expect(seen.length).toBeGreaterThan(before);
      return seen[seen.length - 1];
    };

    expect(after(() => mesh.loadSnapshot(snap)).radii![0]).toBeCloseTo(C_RADIUS, 6);
    expect(after(() => mesh.setUniformRadius(LICORICE_RADIUS, snap)).radii![0]).toBeCloseTo(
      LICORICE_RADIUS,
      6,
    );
    after(() => mesh.setUniformRadius(null, snap));
    expect(after(() => mesh.setScaleOverrides(new Float32Array([0.5, 1]))).radii![0]).toBeCloseTo(
      C_RADIUS * 0.5,
      6,
    );
    expect(after(() => mesh.setHiddenMask(new Uint8Array([1, 0]))).radii![0]).toBe(0);
    expect(after(() => mesh.setOpacityOverrides(new Float32Array([1, 0]))).radii![1]).toBe(0);
    after(() => mesh.clearOverrides());
  });

  it("publishes the global scale and opacity without a per-atom pass", () => {
    const { mesh, seen } = trackedMesh();
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);

    mesh.setScale(2, snap);
    expect(seen[seen.length - 1]).toEqual({ radii: null, scale: 2 });

    // Fully transparent atoms draw no ball, so the trim is switched off with
    // the same scalar rather than by rewriting every radius.
    mesh.setOpacity(0);
    expect(seen[seen.length - 1]).toEqual({ radii: null, scale: 0 });

    mesh.setOpacity(0.4);
    expect(seen[seen.length - 1]).toEqual({ radii: null, scale: 2 });
  });

  it("drops the sink on dispose", () => {
    const { mesh, seen } = trackedMesh();
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    const count = seen.length;
    mesh.dispose();
    // A disposed atom mesh must stop pushing into a bond mesh that is being
    // torn down alongside it.
    mesh.setScale(2, snap);
    expect(seen).toHaveLength(count);
  });

  it("stops publishing once unsubscribed", () => {
    const { mesh, seen } = trackedMesh();
    mesh.loadSnapshot(makeSnapshot());
    const count = seen.length;
    mesh.setRadiusSink(null);
    mesh.setScale(3, makeSnapshot());
    expect(seen).toHaveLength(count);
  });
});

describe("ImpostorBondMesh atom-radius channel", () => {
  it("seeds the texture alpha with per-element ball-and-stick radii", () => {
    const bonds = new ImpostorBondMesh(8);
    bonds.loadSnapshot(makeSnapshot());

    const r = texRadii(bonds, 2);
    expect(r[0]).toBeCloseTo(C_RADIUS, 6);
    expect(r[1]).toBeCloseTo(O_RADIUS, 6);
  });

  it("adopts the atom renderer's effective radii", () => {
    const bonds = new ImpostorBondMesh(8);
    bonds.loadSnapshot(makeSnapshot());
    bonds.setAtomRadii(new Float32Array([0.75, 0]));

    expect(texRadii(bonds, 2)).toEqual([0.75, 0]);
  });

  it("leaves PBC ghost atoms on the element default", () => {
    // updateBondsExt hands the bond mesh an extended snapshot whose atoms past
    // the real-atom range are periodic images drawn by a separate renderer, so
    // the atom mesh's radius array is shorter than the texture.
    const bonds = new ImpostorBondMesh(8);
    bonds.loadSnapshot(makeGhostSnapshot());
    bonds.setAtomRadii(new Float32Array([0.75, 0.5]));

    const r = texRadii(bonds, 3);
    expect(r[0]).toBe(0.75);
    expect(r[1]).toBe(0.5);
    expect(r[2]).toBeCloseTo(C_RADIUS, 6);
  });

  it("keeps the radii across a per-frame position update", () => {
    const bonds = new ImpostorBondMesh(8);
    const snap = makeSnapshot();
    bonds.loadSnapshot(snap);
    bonds.setAtomRadii(new Float32Array([0.75, 0.5]));

    const moved = new Float32Array([0, 1, 2, 3, 4, 5]);
    bonds.updatePositions(moved, snap.bonds, snap.nBonds);

    expect(texPositions(bonds, 2)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(texRadii(bonds, 2)).toEqual([0.75, 0.5]);
  });

  it("re-applies the radii after a topology rebuild", () => {
    // Distance-based bonding re-runs loadSnapshot every frame, which
    // reallocates the position texture — the mirrored radii must survive.
    const bonds = new ImpostorBondMesh(8);
    bonds.loadSnapshot(makeSnapshot());
    bonds.setAtomRadii(new Float32Array([0.75, 0.5]));
    bonds.loadSnapshot(makeSnapshot());

    expect(texRadii(bonds, 2)).toEqual([0.75, 0.5]);
  });

  it("carries the global scale as a uniform, not a per-atom rewrite", () => {
    const bonds = new ImpostorBondMesh(8);
    bonds.loadSnapshot(makeSnapshot());
    bonds.setAtomRadii(new Float32Array([0.75, 0.5]));
    bonds.setAtomRadiusScale(2.5);

    const uniforms = (
      bonds as unknown as {
        bondMaterial: { uniforms: Record<string, { value: number }> };
      }
    ).bondMaterial.uniforms;
    expect(uniforms.uAtomRadiusScale.value).toBe(2.5);
    // The per-atom radii are untouched — the shader multiplies the two.
    expect(texRadii(bonds, 2)).toEqual([0.75, 0.5]);
  });

  it("flags the texture for re-upload when radii change", () => {
    const bonds = new ImpostorBondMesh(8);
    bonds.loadSnapshot(makeSnapshot());
    // `needsUpdate` is write-only on THREE.Texture — it bumps `version`.
    const tex = (bonds as unknown as { positionTex: { version: number } }).positionTex;
    const before = tex.version;
    bonds.setAtomRadii(new Float32Array([0.75, 0.5]));
    expect(tex.version).toBeGreaterThan(before);
  });
});

describe("atom/bond junction shader", () => {
  it("carries the endpoint spheres from the vertex to the fragment stage", () => {
    for (const name of ["vViewCenterA", "vViewCenterB", "vAtomRadiusA", "vAtomRadiusB"]) {
      expect(bondVertexShader).toContain(
        `out ${name.startsWith("vView") ? "vec3" : "float"} ${name}`,
      );
      expect(bondFragmentShader).toContain(
        `in ${name.startsWith("vView") ? "vec3" : "float"} ${name}`,
      );
    }
    // The radius rides in the alpha channel of the position texel, scaled by
    // the global uniform.
    expect(bondVertexShader).toContain("uniform float uAtomRadiusScale");
    expect(bondVertexShader).toContain("vAtomRadiusA = texelA.a * uAtomRadiusScale");
    expect(bondVertexShader).toContain("vAtomRadiusB = texelB.a * uAtomRadiusScale");
  });

  it("discards cylinder fragments inside either endpoint sphere", () => {
    expect(bondFragmentShader).toContain("dot(toA, toA) < vAtomRadiusA * vAtomRadiusA");
    expect(bondFragmentShader).toContain("dot(toB, toB) < vAtomRadiusB * vAtomRadiusB");
  });

  it("trims before shading so discarded fragments cost less, not more", () => {
    const trim = bondFragmentShader.indexOf("dot(toA, toA)");
    const lighting = bondFragmentShader.indexOf("Hemisphere ambient");
    expect(trim).toBeGreaterThan(0);
    expect(trim).toBeLessThan(lighting);
  });
});

describe("MoleculeRenderer sink wiring", () => {
  /**
   * The renderer normally builds its atom/bond pair during canvas init. Stub
   * the scene so swapRenderers can run without a WebGL context — this is the
   * one place the sink is connected, so a refactor that dropped it would
   * silently switch the junction trim off everywhere.
   */
  function swappedRenderer() {
    const renderer = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    internals.scene = { add: () => {}, remove: () => {} };
    internals.swapRenderers(true);
    return {
      atom: internals.atomRenderer as ImpostorAtomMesh,
      bond: internals.bondRenderer as ImpostorBondMesh,
    };
  }

  it("feeds the atom renderer's ball sizes into the bond renderer", () => {
    const { atom, bond } = swappedRenderer();
    const snap = makeSnapshot();

    // Same order MoleculeRenderer.loadSnapshot uses: atoms first, bonds after.
    atom.loadSnapshot(snap);
    bond.loadSnapshot(snap);

    const r = texRadii(bond, 2);
    expect(r[0]).toBeCloseTo(C_RADIUS, 6);
    expect(r[1]).toBeCloseTo(O_RADIUS, 6);
    expect(atomRadiusScale(bond)).toBe(1);
  });

  it("forwards the global scale as a uniform after the pair is wired", () => {
    const { atom, bond } = swappedRenderer();
    const snap = makeSnapshot();
    atom.loadSnapshot(snap);
    bond.loadSnapshot(snap);

    atom.setScale(2, snap);
    expect(atomRadiusScale(bond)).toBe(2);

    // Fading the atoms out entirely switches the trim off without touching the
    // per-atom radii.
    atom.setOpacity(0);
    expect(atomRadiusScale(bond)).toBe(0);
    expect(texRadii(bond, 2)[0]).toBeCloseTo(C_RADIUS, 6);
  });
});
