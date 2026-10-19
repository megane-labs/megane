/**
 * Flow mode's built-in blocks: the ones Builder runs itself, in the browser,
 * without a tool server — a bulk crystal, a supercell, a slab, a polymer
 * chain, and molecules placed on a surface. Each is the Manual mode feature
 * of the same name (the Structure menu's bulk crystal, *Supercell…*, *Cut
 * slab…*, the Place tool's adsorbate height) as a block, built on the same
 * code (`crystal/bulk.ts`, `crystal/transform.ts`, the `add_fragment` op), so
 * a slab built here is atom for atom the one Manual mode cuts.
 */

import { applyEditOps } from "../../pipeline/executors/edit";
import type { EditOp } from "../../pipeline/types";
import type { Snapshot } from "../../types";
import { bulkName, bulkSnapshot, bulkStructureInfo, elementFromSymbol } from "../../crystal/bulk";
import { cross, dot, norm, row, type Vec3 } from "../../crystal/cell";
import { buildSlab, makeSupercell } from "../../crystal/transform";
import { newFragmentId } from "../library/fragment";
import type { FlowPort, PortSources } from "./ports";
import { chainSmiles, polymerLabels, POLYMER_PRESETS, residueName } from "./polymer";
import type {
  AdsorbParams,
  CrystalParams,
  FlowData,
  FlowParams,
  PolymerParams,
  SlabParams,
  SupercellParams,
} from "./types";

/** The block types Builder runs itself. */
export type BuiltinType = "crystal" | "polymer" | "supercell" | "slab" | "adsorb";

export type BuiltinParams =
  | CrystalParams
  | PolymerParams
  | SupercellParams
  | SlabParams
  | AdsorbParams;

export function isBuiltin(params: FlowParams): params is BuiltinParams {
  return (
    params.type === "crystal" ||
    params.type === "polymer" ||
    params.type === "supercell" ||
    params.type === "slab" ||
    params.type === "adsorb"
  );
}

/** Settings of a new block: Cu, a 2×2×2 supercell, a 3×3 (111) slab, … */
export function defaultBuiltinParams(type: BuiltinType): BuiltinParams {
  switch (type) {
    case "crystal":
      return {
        type: "crystal",
        structure: "fcc",
        elements: ["Cu", "", ""],
        a: 3.61,
        covera: Math.sqrt(8 / 3),
        cubic: true,
      };
    case "polymer": {
      const pe = POLYMER_PRESETS[0];
      return { type: "polymer", repeatUnit: pe.repeatUnit, length: 10, name: pe.name };
    }
    case "supercell":
      return { type: "supercell", repeat: [2, 2, 2] };
    case "slab":
      return { type: "slab", miller: [1, 1, 1], layers: 4, vacuum: 10, repeat: [2, 2] };
    case "adsorb":
      return { type: "adsorb", height: 2.5, grid: [1, 1] };
  }
}

const structureInput = (key: string, label: string): FlowPort => ({
  key,
  label,
  multiple: false,
  required: true,
  kind: "document",
  column: null,
});

/** Inputs of the built-in blocks, by type (none for the ones that start a structure). */
export const BUILTIN_PORTS: Record<BuiltinType, FlowPort[]> = {
  crystal: [],
  polymer: [],
  supercell: [structureInput("structure", "Structure")],
  slab: [structureInput("bulk", "Bulk crystal")],
  adsorb: [
    structureInput("surface", "Surface"),
    { ...structureInput("molecule", "Molecule"), kind: "molecule" },
  ],
};

/** Atomic numbers of a crystal block's species, or throws naming the bad one. */
function crystalElements(params: CrystalParams): number[] {
  const { species } = bulkStructureInfo(params.structure);
  const out: number[] = [];
  for (let k = 0; k < species; k++) {
    const z = elementFromSymbol(params.elements[k] ?? "");
    if (z === null) {
      throw new Error(
        `Species ${"ABX"[k]}: "${params.elements[k] ?? ""}" is not an element symbol.`,
      );
    }
    out.push(z);
  }
  return out;
}

/** The bulk crystal a crystal block builds, and its name (`Cu-fcc`). */
export function crystalSpec(params: CrystalParams) {
  const info = bulkStructureInfo(params.structure);
  return {
    structure: params.structure,
    elements: crystalElements(params),
    a: params.a,
    ...(info.hexagonal ? { covera: params.covera } : {}),
    ...(info.cubic ? { cubic: params.cubic } : {}),
  };
}

function positiveInts(values: number[], what: string, max: number): void {
  if (values.some((v) => !Number.isInteger(v) || v < 1 || v > max)) {
    throw new Error(`${what} must be whole numbers from 1 to ${max}.`);
  }
}

/** Labels `labels` repeated `times` times (a supercell's images keep their atom order). */
function repeatLabels(labels: string[] | null, times: number): string[] | null {
  if (!labels) return null;
  const out: string[] = [];
  for (let k = 0; k < times; k++) out.push(...labels);
  return out;
}

/** The unit normal of the a–b plane (pointing along c), or +z without a cell. */
function surfaceNormal(box: ArrayLike<number> | null): Vec3 {
  if (!box) return [0, 0, 1];
  const n = cross(row(box, 0), row(box, 1));
  const len = norm(n);
  if (len < 1e-9) return [0, 0, 1];
  const s = dot(n, row(box, 2)) < 0 ? -1 : 1;
  return [(s * n[0]) / len, (s * n[1]) / len, (s * n[2]) / len];
}

function project(p: ArrayLike<number>, i: number, n: Vec3): number {
  return p[i * 3] * n[0] + p[i * 3 + 1] * n[1] + p[i * 3 + 2] * n[2];
}

/**
 * Copies of `molecule` laid over `surface` on a `grid` of the surface cell's
 * a and b vectors (over the atoms' x–y extent without a cell), each centred
 * on its grid point and lifted so its lowest atom is `height` Å above the
 * surface's top atom along the a–b plane's normal. The molecules keep their
 * orientation. Returns the merged snapshot and the warnings to show.
 */
export function placeOnSurface(
  surface: Snapshot,
  molecule: Snapshot,
  { height, grid }: Pick<AdsorbParams, "height" | "grid">,
): { snapshot: Snapshot; warnings: string[] } {
  if (surface.nAtoms === 0) throw new Error("The surface has no atoms.");
  if (molecule.nAtoms === 0) throw new Error("The molecule has no atoms.");
  if (!Number.isFinite(height)) throw new Error("Height must be a number.");
  positiveInts(grid, "Copies", 20);
  const box = surface.box;
  const normal = surfaceNormal(box);

  let top = -Infinity;
  for (let i = 0; i < surface.nAtoms; i++)
    top = Math.max(top, project(surface.positions, i, normal));
  let low = Infinity;
  let high = -Infinity;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < molecule.nAtoms; i++) {
    const h = project(molecule.positions, i, normal);
    low = Math.min(low, h);
    high = Math.max(high, h);
    for (let k = 0; k < 3; k++) c[k] += molecule.positions[i * 3 + k] / molecule.nAtoms;
  }

  // In-plane frame: the cell's a and b from its origin, else the atoms' x–y box.
  let origin: Vec3;
  let va: Vec3;
  let vb: Vec3;
  if (box) {
    origin = surface.boxOrigin ? ([...surface.boxOrigin] as Vec3) : [0, 0, 0];
    va = row(box, 0);
    vb = row(box, 1);
  } else {
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < surface.nAtoms; i++) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], surface.positions[i * 3 + k]);
        hi[k] = Math.max(hi[k], surface.positions[i * 3 + k]);
      }
    }
    origin = [lo[0], lo[1], 0];
    va = [hi[0] - lo[0], 0, 0];
    vb = [0, hi[1] - lo[1], 0];
  }

  const lift = top + height - low;
  const cn = dot(c, normal);
  const elements = Array.from(molecule.elements);
  const positions = Array.from(molecule.positions);
  const bonds: [number, number][] = [];
  for (let b = 0; b < molecule.nBonds; b++) {
    bonds.push([molecule.bonds[b * 2], molecule.bonds[b * 2 + 1]]);
  }
  const bondOrders = molecule.bondOrders ? Array.from(molecule.bondOrders) : undefined;
  const ops: EditOp[] = [];
  const [na, nb] = grid;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const fa = (i + 0.5) / na;
      const fb = (j + 0.5) / nb;
      const p: Vec3 = [0, 1, 2].map((k) => origin[k] + fa * va[k] + fb * vb[k]) as Vec3;
      const pn = dot(p, normal);
      // Move the centroid onto the grid point in plane, and lift along the normal.
      const translate = [0, 1, 2].map(
        (k) => p[k] - pn * normal[k] - (c[k] - cn * normal[k]) + lift * normal[k],
      ) as [number, number, number];
      ops.push({
        op: "add_fragment",
        id: newFragmentId("adsorbate"),
        elements,
        positions,
        bonds,
        ...(bondOrders ? { bondOrders } : {}),
        translate,
      });
    }
  }
  const merged = applyEditOps(surface, ops);
  const warnings = [...merged.warnings];
  if (box) {
    const ceiling = dot(origin, normal) + dot(row(box, 2), normal);
    if (top + height + (high - low) > ceiling + 1e-6) {
      warnings.push(
        "The molecules reach past the top of the cell; give the slab more vacuum or lower the height.",
      );
    }
  }
  return { snapshot: merged.snapshot, warnings };
}

/** What a built-in block needs from the outside: RDKit for the polymer. */
export interface BuiltinDeps {
  embedSmiles: (smiles: string) => Promise<Snapshot>;
}

export interface BuiltinResult {
  data: FlowData;
  warnings: string[];
}

/** The structure wired into a block's single input `key`, or throws asking for it. */
function input(port: FlowPort, sources: PortSources, inputs: Record<string, FlowData>): FlowData {
  const id = sources[port.key]?.[0];
  const data = id ? inputs[id] : undefined;
  if (!data) throw new Error(`Connect a block to ${port.label}.`);
  return data;
}

/** Run one built-in block. Rejects with the message to show on it. */
export async function runBuiltin(
  params: BuiltinParams,
  sources: PortSources,
  inputs: Record<string, FlowData>,
  deps: BuiltinDeps,
): Promise<BuiltinResult> {
  const ports = BUILTIN_PORTS[params.type];
  const inputOf = (key: string) => input(ports.find((p) => p.key === key)!, sources, inputs);
  switch (params.type) {
    case "crystal": {
      const spec = crystalSpec(params);
      return {
        data: { name: bulkName(spec), snapshot: bulkSnapshot(spec), labels: null },
        warnings: [],
      };
    }
    case "polymer": {
      const { smiles, unit } = chainSmiles(params.repeatUnit, params.length);
      const snapshot = await deps.embedSmiles(smiles);
      const name = params.name.trim() || params.repeatUnit.trim();
      const labels = polymerLabels(
        snapshot.elements,
        snapshot.bonds,
        unit,
        params.length,
        residueName(name, "POL"),
      );
      return { data: { name, snapshot, labels }, warnings: [] };
    }
    case "supercell": {
      const src = inputOf("structure");
      positiveInts(params.repeat, "Repeats", 20);
      const [na, nb, nc] = params.repeat;
      const snapshot = makeSupercell(src.snapshot, [na, 0, 0, 0, nb, 0, 0, 0, nc]);
      if (!snapshot) throw new Error("A supercell needs a structure with a unit cell.");
      return {
        data: { name: src.name, snapshot, labels: repeatLabels(src.labels, na * nb * nc) },
        warnings: [],
      };
    }
    case "slab": {
      const src = inputOf("bulk");
      const [h, k, l] = params.miller;
      if (![h, k, l].every(Number.isInteger) || (h === 0 && k === 0 && l === 0)) {
        throw new Error("Miller indices must be whole numbers, not all zero.");
      }
      positiveInts([params.layers], "Layers", 50);
      positiveInts(params.repeat, "Repeats", 20);
      if (!(params.vacuum >= 0)) throw new Error("Vacuum must be zero or more.");
      const slab = buildSlab(src.snapshot, {
        miller: [h, k, l],
        layers: params.layers,
        vacuum: params.vacuum,
      });
      if (!slab)
        throw new Error("A slab is cut from a bulk crystal: wire in a structure with a unit cell.");
      const [na, nb] = params.repeat;
      const snapshot =
        na === 1 && nb === 1 ? slab : makeSupercell(slab, [na, 0, 0, 0, nb, 0, 0, 0, 1])!;
      return {
        data: { name: `${src.name}(${h}${k}${l})`, snapshot, labels: null },
        warnings: [],
      };
    }
    case "adsorb": {
      const surface = inputOf("surface");
      const molecule = inputOf("molecule");
      const { snapshot, warnings } = placeOnSurface(surface.snapshot, molecule.snapshot, params);
      const copies = params.grid[0] * params.grid[1];
      const resname = residueName(molecule.name);
      const labels = [
        ...(surface.labels ??
          Array.from(
            { length: surface.snapshot.nAtoms },
            () => `${residueName(surface.name, "SURF")}1`,
          )),
      ];
      for (let k = 0; k < copies; k++) {
        for (let i = 0; i < molecule.snapshot.nAtoms; i++) labels.push(`${resname}${k + 1}`);
      }
      return {
        data: {
          name: surface.name,
          snapshot,
          labels: labels.length === snapshot.nAtoms ? labels : null,
        },
        warnings,
      };
    }
  }
}
