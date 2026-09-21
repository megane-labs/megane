import type { Snapshot } from "../../types";
import type { EditOp, EditAtomRef } from "../types";
import { cartToFrac, fracToCart, inverse3 } from "../../crystal/cell";
import { buildSlab, centerSnapshot, makeSupercell, wrapSnapshot } from "../../crystal/transform";
import { expandSymmetry } from "./symmetry";

/**
 * Structure edits — replays a `load_structure` node's edit list on the
 * structure as loaded from the file (see `LoadStructureParams.edits`).
 *
 * Every op is applied in order against a working copy keyed by *atom
 * reference* rather than by index: file atoms are referenced by their index in
 * the loaded Snapshot, atoms created by an `add_atom` / `add_fragment` op by
 * the id that op assigned. Deleting an atom therefore never shifts the meaning
 * of a later op, which is what makes the op list a safe undo history (the
 * Builder undoes by dropping the last op and replaying the rest).
 *
 * The whole-structure ops (`supercell`, `slab`, `expand_symmetry`) replace
 * every atom: their result is re-keyed as `<id>:<k>` for the k-th output
 * atom, so refs written before such an op no longer resolve after it (the
 * Builder always addresses the structure it currently shows). `wrap`,
 * `center` and a scaling `set_cell` only move atoms and keep every ref.
 *
 * The result is a brand-new immutable Snapshot; the renderer keys on Snapshot
 * identity, so a re-run after a new op is a real reload.
 */

/** Outcome of `applyEditOps`: the edited snapshot plus provenance. */
export interface EditResult {
  snapshot: Snapshot;
  /** For each output atom, the ref it is addressed by inside the op list. */
  outputRefs: EditAtomRef[];
  /** Ops that could not be applied (unknown ref, …) are skipped and reported. */
  warnings: string[];
}

interface WorkingBond {
  a: EditAtomRef;
  b: EditAtomRef;
  order: number;
}

/** Canonical key so (a,b) and (b,a) name the same bond. */
function bondKey(a: EditAtomRef, b: EditAtomRef): string {
  const ka = typeof a === "number" ? `#${a}` : `@${a}`;
  const kb = typeof b === "number" ? `#${b}` : `@${b}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function describeRef(ref: EditAtomRef): string {
  return typeof ref === "number" ? `atom ${ref}` : `atom "${ref}"`;
}

/** Fragment atom ids are `<fragmentId>:<k>`. */
export function fragmentAtomRef(fragmentId: string, k: number): string {
  return `${fragmentId}:${k}`;
}

/**
 * Apply `ops` to `src` and build the resulting Snapshot. Pure: `src` is never
 * mutated. Unknown refs and malformed ops are skipped with a warning rather
 * than thrown, so one bad op (e.g. after the input file changed) does not blank
 * the whole structure.
 */
export function applyEditOps(src: Snapshot, ops: EditOp[]): EditResult {
  const warnings: string[] = [];

  // Working copy. `refs[i]` is the reference of working atom i; `byRef` is its
  // inverse and is rebuilt after every deletion.
  const refs: EditAtomRef[] = [];
  const pos: number[] = [];
  const elem: number[] = [];
  let chain: number[] | null = src.atomChainIds ? [] : null;
  let bfac: number[] | null = src.atomBFactors ? [] : null;
  for (let i = 0; i < src.nAtoms; i++) {
    refs.push(i);
    pos.push(src.positions[i * 3], src.positions[i * 3 + 1], src.positions[i * 3 + 2]);
    elem.push(src.elements[i]);
    if (chain) chain.push(src.atomChainIds![i]);
    if (bfac) bfac.push(src.atomBFactors![i]);
  }
  let byRef = new Map<EditAtomRef, number>(refs.map((r, i) => [r, i]));

  const bonds: WorkingBond[] = [];
  const bondIndex = new Map<string, number>();
  let hasOrders = src.bondOrders !== null;
  for (let b = 0; b < src.nBonds; b++) {
    const a = src.bonds[b * 2];
    const c = src.bonds[b * 2 + 1];
    const key = bondKey(a, c);
    if (bondIndex.has(key)) continue;
    bondIndex.set(key, bonds.length);
    bonds.push({ a, b: c, order: src.bondOrders ? src.bondOrders[b] : 1 });
  }
  let box: number[] | null = src.box ? Array.from(src.box) : null;
  let cellTouched = false;
  // Set once a whole-structure op consumed the file's space-group operations
  // (or changed the cell they describe), so the viewer's Symmetry node does
  // not expand the result a second time.
  let symmetryConsumed = false;

  const rebuildByRef = () => {
    byRef = new Map(refs.map((r, i) => [r, i]));
  };

  const resolve = (ref: EditAtomRef, opName: string): number | null => {
    const idx = byRef.get(ref);
    if (idx === undefined) {
      warnings.push(`${opName}: unknown ${describeRef(ref)} (skipped)`);
      return null;
    }
    return idx;
  };

  const addAtom = (ref: EditAtomRef, element: number, x: number, y: number, z: number) => {
    if (byRef.has(ref)) {
      warnings.push(`add_atom: ${describeRef(ref)} already exists (skipped)`);
      return false;
    }
    byRef.set(ref, refs.length);
    refs.push(ref);
    pos.push(x, y, z);
    elem.push(clampElement(element));
    if (chain) chain.push(0);
    if (bfac) bfac.push(0);
    return true;
  };

  const addBond = (a: EditAtomRef, b: EditAtomRef, order: number | undefined, opName: string) => {
    if (a === b) {
      warnings.push(`${opName}: cannot bond ${describeRef(a)} to itself (skipped)`);
      return;
    }
    if (resolve(a, opName) === null || resolve(b, opName) === null) return;
    const key = bondKey(a, b);
    const ord = clampOrder(order);
    if (order !== undefined) hasOrders = true;
    const existing = bondIndex.get(key);
    if (existing !== undefined) {
      bonds[existing].order = ord;
      return;
    }
    bondIndex.set(key, bonds.length);
    bonds.push({ a, b, order: ord });
  };

  const removeBondsTouching = (dead: Set<EditAtomRef>) => {
    let w = 0;
    for (let i = 0; i < bonds.length; i++) {
      const bd = bonds[i];
      if (dead.has(bd.a) || dead.has(bd.b)) continue;
      bonds[w++] = bd;
    }
    bonds.length = w;
    bondIndex.clear();
    bonds.forEach((bd, i) => bondIndex.set(bondKey(bd.a, bd.b), i));
  };

  /** The working structure as a Snapshot (bonds by current index), for the whole-structure ops. */
  const materialize = (): Snapshot => {
    const b = new Uint32Array(bonds.length * 2);
    const o = hasOrders ? new Uint8Array(bonds.length) : null;
    bonds.forEach((bd, i) => {
      b[i * 2] = byRef.get(bd.a)!;
      b[i * 2 + 1] = byRef.get(bd.b)!;
      if (o) o[i] = bd.order;
    });
    return {
      nAtoms: refs.length,
      nBonds: bonds.length,
      nFileBonds: bonds.length,
      positions: new Float32Array(pos),
      elements: new Uint8Array(elem),
      bonds: b,
      bondOrders: o,
      box: box ? new Float32Array(box) : null,
      boxOrigin: cellTouched ? null : src.boxOrigin,
      atomChainIds: chain ? new Uint8Array(chain) : null,
      atomBFactors: bfac ? new Float32Array(bfac) : null,
      symmetryOps: symmetryConsumed ? undefined : src.symmetryOps,
    };
  };

  /** Replace the working structure with `snap`, re-keying its atoms as `<id>:<k>`. */
  const rebuildFrom = (snap: Snapshot, id: string) => {
    refs.length = 0;
    pos.length = 0;
    elem.length = 0;
    chain = snap.atomChainIds ? [] : null;
    bfac = snap.atomBFactors ? [] : null;
    for (let i = 0; i < snap.nAtoms; i++) {
      refs.push(fragmentAtomRef(id, i));
      pos.push(snap.positions[i * 3], snap.positions[i * 3 + 1], snap.positions[i * 3 + 2]);
      elem.push(snap.elements[i]);
      if (chain) chain.push(snap.atomChainIds![i]);
      if (bfac) bfac.push(snap.atomBFactors![i]);
    }
    rebuildByRef();
    bonds.length = 0;
    bondIndex.clear();
    hasOrders = snap.bondOrders !== null;
    for (let b = 0; b < snap.nBonds; b++) {
      const a = refs[snap.bonds[b * 2]];
      const c = refs[snap.bonds[b * 2 + 1]];
      const key = bondKey(a, c);
      if (bondIndex.has(key)) continue;
      bondIndex.set(key, bonds.length);
      bonds.push({ a, b: c, order: snap.bondOrders ? snap.bondOrders[b] : 1 });
    }
    box = snap.box ? Array.from(snap.box) : null;
    cellTouched = true;
    symmetryConsumed = true;
  };

  /** Take only the positions (and cell) of `snap`: the atoms and their refs are unchanged. */
  const adoptPositions = (snap: Snapshot) => {
    for (let i = 0; i < snap.nAtoms * 3; i++) pos[i] = snap.positions[i];
    box = snap.box ? Array.from(snap.box) : null;
  };

  for (const op of ops) {
    switch (op.op) {
      case "add_atom": {
        const [x, y, z] = op.position;
        if (!addAtom(op.id, op.element, x, y, z)) break;
        if (op.bondTo !== undefined) addBond(op.id, op.bondTo, op.order, "add_atom");
        break;
      }
      case "add_fragment": {
        const n = op.elements.length;
        if (op.positions.length !== n * 3) {
          warnings.push(
            `add_fragment "${op.id}": positions length does not match elements (skipped)`,
          );
          break;
        }
        const [tx, ty, tz] = op.translate ?? [0, 0, 0];
        let ok = true;
        for (let k = 0; k < n; k++) {
          if (
            !addAtom(
              fragmentAtomRef(op.id, k),
              op.elements[k],
              op.positions[k * 3] + tx,
              op.positions[k * 3 + 1] + ty,
              op.positions[k * 3 + 2] + tz,
            )
          ) {
            ok = false;
          }
        }
        if (!ok) break;
        op.bonds.forEach(([i, j], bi) => {
          if (i < 0 || j < 0 || i >= n || j >= n) {
            warnings.push(`add_fragment "${op.id}": bond (${i}, ${j}) is out of range (skipped)`);
            return;
          }
          addBond(
            fragmentAtomRef(op.id, i),
            fragmentAtomRef(op.id, j),
            op.bondOrders?.[bi],
            "add_fragment",
          );
        });
        break;
      }
      case "delete_atoms": {
        const dead = new Set<EditAtomRef>();
        for (const ref of op.atoms) {
          if (resolve(ref, "delete_atoms") !== null) dead.add(ref);
        }
        if (dead.size === 0) break;
        let w = 0;
        for (let i = 0; i < refs.length; i++) {
          if (dead.has(refs[i])) continue;
          refs[w] = refs[i];
          pos[w * 3] = pos[i * 3];
          pos[w * 3 + 1] = pos[i * 3 + 1];
          pos[w * 3 + 2] = pos[i * 3 + 2];
          elem[w] = elem[i];
          if (chain) chain[w] = chain[i];
          if (bfac) bfac[w] = bfac[i];
          w++;
        }
        refs.length = w;
        pos.length = w * 3;
        elem.length = w;
        if (chain) chain.length = w;
        if (bfac) bfac.length = w;
        rebuildByRef();
        removeBondsTouching(dead);
        break;
      }
      case "move_atoms": {
        const [dx, dy, dz] = op.delta;
        for (const ref of op.atoms) {
          const i = resolve(ref, "move_atoms");
          if (i === null) continue;
          pos[i * 3] += dx;
          pos[i * 3 + 1] += dy;
          pos[i * 3 + 2] += dz;
        }
        break;
      }
      case "set_element": {
        const z = clampElement(op.element);
        for (const ref of op.atoms) {
          const i = resolve(ref, "set_element");
          if (i !== null) elem[i] = z;
        }
        break;
      }
      case "add_bond":
        addBond(op.a, op.b, op.order, "add_bond");
        break;
      case "delete_bond": {
        if (resolve(op.a, "delete_bond") === null || resolve(op.b, "delete_bond") === null) break;
        const key = bondKey(op.a, op.b);
        const idx = bondIndex.get(key);
        if (idx === undefined) {
          warnings.push(
            `delete_bond: no bond between ${describeRef(op.a)} and ${describeRef(op.b)} (skipped)`,
          );
          break;
        }
        bonds.splice(idx, 1);
        bondIndex.clear();
        bonds.forEach((bd, i) => bondIndex.set(bondKey(bd.a, bd.b), i));
        break;
      }
      case "set_cell": {
        if (op.box !== null && op.box.length !== 9) {
          warnings.push("set_cell: box must have 9 values (skipped)");
          break;
        }
        if (op.scaleAtoms && op.box !== null && box !== null) {
          const oldInv = inverse3(box);
          if (oldInv) {
            const cart = fracToCart(cartToFrac(pos, oldInv), op.box);
            for (let i = 0; i < cart.length; i++) pos[i] = cart[i];
          } else {
            warnings.push("set_cell: the current cell is singular, atoms were not scaled");
          }
        }
        box = op.box === null ? null : [...op.box];
        cellTouched = true;
        symmetryConsumed = true;
        break;
      }
      case "supercell": {
        if (box === null) {
          warnings.push(`supercell "${op.id}": the structure has no cell (skipped)`);
          break;
        }
        const out = makeSupercell(materialize(), op.matrix);
        if (!out) {
          warnings.push(
            `supercell "${op.id}": matrix must be 9 integers with a non-zero determinant (skipped)`,
          );
          break;
        }
        rebuildFrom(out, op.id);
        break;
      }
      case "slab": {
        if (box === null) {
          warnings.push(`slab "${op.id}": the structure has no cell (skipped)`);
          break;
        }
        const out = buildSlab(materialize(), {
          miller: op.miller,
          layers: op.layers,
          vacuum: op.vacuum,
          shift: op.shift,
        });
        if (!out) {
          warnings.push(`slab "${op.id}": Miller indices must be integers, not all zero (skipped)`);
          break;
        }
        rebuildFrom(out, op.id);
        break;
      }
      case "expand_symmetry": {
        const cur = materialize();
        if (!cur.symmetryOps?.length) {
          warnings.push(`expand_symmetry "${op.id}": no symmetry operations to apply (skipped)`);
          break;
        }
        if (!cur.box) {
          warnings.push(`expand_symmetry "${op.id}": the structure has no cell (skipped)`);
          break;
        }
        const out = expandSymmetry(cur, cur.box, cur.symmetryOps);
        // Identity-only operations: nothing to expand, but they are consumed.
        if (out) rebuildFrom(out, op.id);
        symmetryConsumed = true;
        break;
      }
      case "wrap": {
        const out = box === null ? null : wrapSnapshot(materialize());
        if (!out) {
          warnings.push("wrap: the structure has no usable cell (skipped)");
          break;
        }
        adoptPositions(out);
        break;
      }
      case "center": {
        const axes = op.axes ?? [0, 1, 2];
        const out = box === null ? null : centerSnapshot(materialize(), axes, op.vacuum);
        if (!out) {
          warnings.push("center: the structure has no usable cell (skipped)");
          break;
        }
        adoptPositions(out);
        if (op.vacuum !== null && op.vacuum !== undefined) {
          cellTouched = true;
          symmetryConsumed = true;
        }
        break;
      }
      default: {
        const unknown = op as { op?: unknown };
        warnings.push(`unknown edit op "${String(unknown.op)}" (skipped)`);
      }
    }
  }

  // Materialize the Snapshot.
  const nAtoms = refs.length;
  const nBonds = bonds.length;
  const bondsOut = new Uint32Array(nBonds * 2);
  const ordersOut = hasOrders ? new Uint8Array(nBonds) : null;
  for (let i = 0; i < nBonds; i++) {
    const bd = bonds[i];
    const ia = byRef.get(bd.a)!;
    const ib = byRef.get(bd.b)!;
    bondsOut[i * 2] = Math.min(ia, ib);
    bondsOut[i * 2 + 1] = Math.max(ia, ib);
    if (ordersOut) ordersOut[i] = bd.order;
  }

  // Cα backbone: keep the entries whose atom survived, remapped to new indices.
  let caIndices: Uint32Array | undefined;
  let caChainIds: Uint8Array | undefined;
  let caResNums: Uint32Array | undefined;
  let caSsType: Uint8Array | undefined;
  if (src.caIndices) {
    const keep: number[] = [];
    const mapped: number[] = [];
    for (let c = 0; c < src.caIndices.length; c++) {
      const ni = byRef.get(src.caIndices[c]);
      if (ni !== undefined) {
        keep.push(c);
        mapped.push(ni);
      }
    }
    caIndices = new Uint32Array(mapped);
    if (src.caChainIds) caChainIds = new Uint8Array(keep.map((c) => src.caChainIds![c]));
    if (src.caResNums) caResNums = new Uint32Array(keep.map((c) => src.caResNums![c]));
    if (src.caSsType) caSsType = new Uint8Array(keep.map((c) => src.caSsType![c]));
  }

  const snapshot: Snapshot = {
    nAtoms,
    nBonds,
    // Every surviving bond is now asserted by the edit, so downstream code
    // treats the whole set as declared (not distance-inferred) connectivity.
    nFileBonds: nBonds,
    positions: new Float32Array(pos),
    elements: new Uint8Array(elem),
    bonds: bondsOut,
    bondOrders: ordersOut,
    box: box ? new Float32Array(box) : null,
    boxOrigin: cellTouched ? null : src.boxOrigin,
    atomChainIds: chain ? new Uint8Array(chain) : null,
    atomBFactors: bfac ? new Float32Array(bfac) : null,
    caIndices,
    caChainIds,
    caResNums,
    caSsType,
    symmetryOps: symmetryConsumed ? undefined : src.symmetryOps,
  };

  return { snapshot, outputRefs: refs, warnings };
}

function clampElement(z: number): number {
  const v = Math.round(Number(z));
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(118, v);
}

function clampOrder(order: number | undefined): number {
  if (order === undefined) return 1;
  const v = Math.round(Number(order));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(4, v);
}

/**
 * Remap a per-atom float array (`channels` values per atom) from input atom
 * indices to output atoms. Atoms created by the edit get `fill`.
 */
