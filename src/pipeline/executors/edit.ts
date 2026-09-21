import type { Snapshot } from "../../types";
import type { EditOp, EditAtomRef } from "../types";
import { cartToFrac, fracToCart, inverse3 } from "../../crystal/cell";
import {
  buildSlab,
  centerSnapshot,
  repeatedBondPairs,
  makeSupercell,
  wrapSnapshot,
} from "../../crystal/transform";
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
 * Those ops multiply the atom count (a slab of a slab stacks the whole
 * structure again), so the working copy is kept in typed arrays and the refs
 * implicitly (`RefTable`): no string per atom, no key string per bond, and a
 * pair lookup goes through a compact adjacency index built only when an op
 * needs one. That is what keeps a few repeated cuts from exhausting the tab.
 *
 * The result is a brand-new immutable Snapshot; the renderer keys on Snapshot
 * identity, so a re-run after a new op is a real reload.
 */

/** Outcome of `applyEditOps`: the edited snapshot plus provenance. */
export interface EditResult {
  snapshot: Snapshot;
  /** The ref output atom `i` is addressed by inside the op list. */
  refAt: (i: number) => EditAtomRef;
  /**
   * For each output atom, the ref it is addressed by inside the op list.
   * Materialized (one string per atom) on first access; prefer `refAt` for a
   * few atoms of a large structure.
   */
  readonly outputRefs: EditAtomRef[];
  /** Ops that could not be applied (unknown ref, …) are skipped and reported. */
  warnings: string[];
}

const NONE = 0xffffffff;

function describeRef(ref: EditAtomRef): string {
  return typeof ref === "number" ? `atom ${ref}` : `atom "${ref}"`;
}

/** Fragment atom ids are `<fragmentId>:<k>`. */
export function fragmentAtomRef(fragmentId: string, k: number): string {
  return `${fragmentId}:${k}`;
}

function grow32(a: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(Math.max(n, a.length * 2, 16));
  out.set(a);
  return out;
}

function grow8(a: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(Math.max(n, a.length * 2, 16));
  out.set(a);
  return out;
}

function grow64(a: Float64Array, n: number): Float64Array {
  const out = new Float64Array(Math.max(n, a.length * 2, 16));
  out.set(a);
  return out;
}

function growF32(a: Float32Array, n: number): Float32Array {
  const out = new Float32Array(Math.max(n, a.length * 2, 16));
  out.set(a);
  return out;
}

/**
 * The refs of the working atoms without one string per atom. Atoms that came
 * from the *base* structure — the file, or the last whole-structure op, whose
 * id is `base` — are addressed as `k` (file) or `<base>:<k>`, and only `k` is
 * stored; the inverse map `k → index` is rebuilt lazily after a deletion.
 * Atoms an `add_atom` / `add_fragment` created keep their explicit ref in a
 * side map that only ever holds those few.
 */
class RefTable {
  private base: string | null = null;
  /** Base index of working atom i, or NONE for an added atom. */
  private k: Uint32Array = new Uint32Array(0);
  /** Refs of the added atoms, by working index. */
  private extra = new Map<number, EditAtomRef>();
  private extraIndex = new Map<EditAtomRef, number>();
  /** k → working index (NONE once deleted); null until needed. */
  private kIndex: Uint32Array | null = null;
  private nBase = 0;
  n = 0;

  /** Every atom is the base atom of the same index; `base` null means file atoms. */
  reset(base: string | null, n: number): void {
    this.base = base;
    this.nBase = n;
    this.n = n;
    this.k = new Uint32Array(Math.max(n, 16));
    for (let i = 0; i < n; i++) this.k[i] = i;
    this.kIndex = null;
    this.extra.clear();
    this.extraIndex.clear();
  }

  refAt(i: number): EditAtomRef {
    const k = this.k[i];
    if (k !== NONE) return this.base === null ? k : `${this.base}:${k}`;
    return this.extra.get(i)!;
  }

  indexOf(ref: EditAtomRef): number | undefined {
    if (typeof ref === "number") {
      if (this.base === null && Number.isInteger(ref) && ref >= 0 && ref < this.nBase) {
        const i = this.byK()[ref];
        if (i !== NONE) return i;
      }
    } else if (this.base !== null && ref.startsWith(`${this.base}:`)) {
      const rest = ref.slice(this.base.length + 1);
      const k = Number(rest);
      if (Number.isInteger(k) && k >= 0 && k < this.nBase && String(k) === rest) {
        const i = this.byK()[k];
        if (i !== NONE) return i;
      }
    }
    return this.extraIndex.get(ref);
  }

  has(ref: EditAtomRef): boolean {
    return this.indexOf(ref) !== undefined;
  }

  /** Append an added atom with an explicit ref (the caller checked it is new). */
  push(ref: EditAtomRef): void {
    if (this.n === this.k.length) this.k = grow32(this.k, this.n + 1);
    this.k[this.n] = NONE;
    this.extra.set(this.n, ref);
    this.extraIndex.set(ref, this.n);
    this.n++;
  }

  /**
   * Drop every atom whose `keep[i]` is 0, preserving order; returns the map
   * from old to new index (NONE for a dropped atom).
   */
  compact(keep: Uint8Array): Uint32Array {
    const map = new Uint32Array(this.n).fill(NONE);
    const extra = new Map<number, EditAtomRef>();
    this.extraIndex.clear();
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      if (!keep[i]) continue;
      map[i] = w;
      this.k[w] = this.k[i];
      if (this.k[i] === NONE) {
        const ref = this.extra.get(i)!;
        extra.set(w, ref);
        this.extraIndex.set(ref, w);
      }
      w++;
    }
    this.n = w;
    this.extra = extra;
    this.kIndex = null;
    return map;
  }

  toArray(): EditAtomRef[] {
    const out = new Array<EditAtomRef>(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.refAt(i);
    return out;
  }

  private byK(): Uint32Array {
    if (!this.kIndex) {
      this.kIndex = new Uint32Array(this.nBase).fill(NONE);
      for (let i = 0; i < this.n; i++) {
        const k = this.k[i];
        if (k !== NONE) this.kIndex[k] = i;
      }
    }
    return this.kIndex;
  }
}

/**
 * Apply `ops` to `src` and build the resulting Snapshot. Pure: `src` is never
 * mutated. Unknown refs and malformed ops are skipped with a warning rather
 * than thrown, so one bad op (e.g. after the input file changed) does not blank
 * the whole structure.
 */
export function applyEditOps(src: Snapshot, ops: EditOp[]): EditResult {
  const warnings: string[] = [];

  // ── Working atoms: `refs.n` of them, channels in typed arrays with slack. ──
  const refs = new RefTable();
  let pos: Float64Array = new Float64Array(0);
  let elem: Uint8Array = new Uint8Array(0);
  // (Assigned inside `load`, which TypeScript's narrowing does not see.)
  let chain = null as Uint8Array | null;
  let bfac = null as Float32Array | null;

  // ── Working bonds by current atom index; a deleted bond is a dead slot. ──
  let bondA: Uint32Array = new Uint32Array(0);
  let bondB: Uint32Array = new Uint32Array(0);
  let bondOrd: Uint8Array = new Uint8Array(0);
  let bondDead: Uint8Array = new Uint8Array(0);
  let nBonds = 0;
  let nDeadBonds = 0;
  let hasOrders = false;
  // Pair lookup: a CSR adjacency over bonds `[0, adjCount)`, built on first
  // use and rebuilt once the bonds appended since (scanned linearly) pile up.
  let adjOff: Uint32Array | null = null;
  let adjOther: Uint32Array = new Uint32Array(0);
  let adjSlot: Uint32Array = new Uint32Array(0);
  let adjCount = 0;

  let box: number[] | null = src.box ? Array.from(src.box) : null;
  let cellTouched = false;
  // Set once a whole-structure op consumed the file's space-group operations
  // (or changed the cell they describe), so the viewer's Symmetry node does
  // not expand the result a second time.
  let symmetryConsumed = false;

  /** Replace the working atoms and bonds with `snap`'s, refs keyed by `base`. */
  const load = (snap: Snapshot, base: string | null, uniqueBonds: boolean) => {
    const n = snap.nAtoms;
    refs.reset(base, n);
    pos = new Float64Array(Math.max(n, 16) * 3);
    pos.set(snap.positions.subarray(0, n * 3));
    elem = new Uint8Array(Math.max(n, 16));
    elem.set(snap.elements.subarray(0, n));
    chain = null;
    bfac = null;
    if (snap.atomChainIds) {
      chain = new Uint8Array(Math.max(n, 16));
      chain.set(snap.atomChainIds.subarray(0, n));
    }
    if (snap.atomBFactors) {
      bfac = new Float32Array(Math.max(n, 16));
      bfac.set(snap.atomBFactors.subarray(0, n));
    }
    const nb = snap.nBonds;
    // A pair the file lists twice keeps its first entry.
    const repeats = uniqueBonds ? null : repeatedBondPairs(snap.bonds, nb, n);
    bondA = new Uint32Array(Math.max(nb, 16));
    bondB = new Uint32Array(Math.max(nb, 16));
    bondOrd = new Uint8Array(Math.max(nb, 16));
    bondDead = new Uint8Array(Math.max(nb, 16));
    nBonds = 0;
    nDeadBonds = 0;
    hasOrders = snap.bondOrders !== null;
    for (let b = 0; b < nb; b++) {
      if (repeats && repeats[b] === 2) continue;
      bondA[nBonds] = snap.bonds[b * 2];
      bondB[nBonds] = snap.bonds[b * 2 + 1];
      bondOrd[nBonds] = snap.bondOrders ? snap.bondOrders[b] : 1;
      nBonds++;
    }
    adjOff = null;
  };

  const resolve = (ref: EditAtomRef, opName: string): number | null => {
    const idx = refs.indexOf(ref);
    if (idx === undefined) {
      warnings.push(`${opName}: unknown ${describeRef(ref)} (skipped)`);
      return null;
    }
    return idx;
  };

  const addAtom = (ref: EditAtomRef, element: number, x: number, y: number, z: number) => {
    if (refs.has(ref)) {
      warnings.push(`add_atom: ${describeRef(ref)} already exists (skipped)`);
      return false;
    }
    const i = refs.n;
    refs.push(ref);
    if ((i + 1) * 3 > pos.length) pos = grow64(pos, (i + 1) * 3);
    if (i + 1 > elem.length) elem = grow8(elem, i + 1);
    if (chain && i + 1 > chain.length) chain = grow8(chain, i + 1);
    if (bfac && i + 1 > bfac.length) bfac = growF32(bfac, i + 1);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    elem[i] = clampElement(element);
    if (chain) chain[i] = 0;
    if (bfac) bfac[i] = 0;
    return true;
  };

  const buildAdjacency = () => {
    const n = refs.n;
    const off = new Uint32Array(n + 1);
    for (let s = 0; s < nBonds; s++) {
      if (bondDead[s]) continue;
      off[bondA[s] + 1]++;
      off[bondB[s] + 1]++;
    }
    for (let a = 0; a < n; a++) off[a + 1] += off[a];
    const cursor = off.slice(0, n);
    const other = new Uint32Array(off[n]);
    const slot = new Uint32Array(off[n]);
    for (let s = 0; s < nBonds; s++) {
      if (bondDead[s]) continue;
      const a = bondA[s];
      const b = bondB[s];
      let p = cursor[a]++;
      other[p] = b;
      slot[p] = s;
      p = cursor[b]++;
      other[p] = a;
      slot[p] = s;
    }
    adjOff = off;
    adjOther = other;
    adjSlot = slot;
    adjCount = nBonds;
  };

  /** Slot of the live bond between atoms `i` and `j`, or -1. */
  const findBond = (i: number, j: number): number => {
    if (!adjOff || nBonds - adjCount > 64 + (adjCount >> 4)) buildAdjacency();
    // An atom added since the index was built has no entry; its bonds are
    // all newer than the index and are found by the scan below.
    if (i + 1 < adjOff!.length) {
      for (let p = adjOff![i]; p < adjOff![i + 1]; p++) {
        if (adjOther[p] === j && !bondDead[adjSlot[p]]) return adjSlot[p];
      }
    }
    for (let s = adjCount; s < nBonds; s++) {
      if (bondDead[s]) continue;
      if ((bondA[s] === i && bondB[s] === j) || (bondA[s] === j && bondB[s] === i)) return s;
    }
    return -1;
  };

  const addBond = (a: EditAtomRef, b: EditAtomRef, order: number | undefined, opName: string) => {
    if (a === b) {
      warnings.push(`${opName}: cannot bond ${describeRef(a)} to itself (skipped)`);
      return;
    }
    const i = resolve(a, opName);
    if (i === null) return;
    const j = resolve(b, opName);
    if (j === null) return;
    const ord = clampOrder(order);
    if (order !== undefined) hasOrders = true;
    const existing = findBond(i, j);
    if (existing >= 0) {
      bondOrd[existing] = ord;
      return;
    }
    if (nBonds === bondA.length) {
      bondA = grow32(bondA, nBonds + 1);
      bondB = grow32(bondB, nBonds + 1);
      bondOrd = grow8(bondOrd, nBonds + 1);
      bondDead = grow8(bondDead, nBonds + 1);
    }
    bondA[nBonds] = i;
    bondB[nBonds] = j;
    bondOrd[nBonds] = ord;
    bondDead[nBonds] = 0;
    nBonds++;
  };

  /** The live bonds as a Snapshot's `bonds` (each pair low index first) and orders. */
  const liveBonds = (): { bonds: Uint32Array; orders: Uint8Array | null } => {
    const live = nBonds - nDeadBonds;
    const bonds = new Uint32Array(live * 2);
    const orders = hasOrders ? new Uint8Array(live) : null;
    let w = 0;
    for (let s = 0; s < nBonds; s++) {
      if (bondDead[s]) continue;
      bonds[w * 2] = Math.min(bondA[s], bondB[s]);
      bonds[w * 2 + 1] = Math.max(bondA[s], bondB[s]);
      if (orders) orders[w] = bondOrd[s];
      w++;
    }
    return { bonds, orders };
  };

  /** The working structure as a Snapshot (bonds by current index), for the whole-structure ops. */
  const materialize = (): Snapshot => {
    const n = refs.n;
    const { bonds, orders } = liveBonds();
    return {
      nAtoms: n,
      nBonds: bonds.length / 2,
      nFileBonds: bonds.length / 2,
      positions: new Float32Array(pos.subarray(0, n * 3)),
      elements: elem.slice(0, n),
      bonds,
      bondOrders: orders,
      box: box ? new Float32Array(box) : null,
      boxOrigin: cellTouched ? null : src.boxOrigin,
      atomChainIds: chain ? chain.slice(0, n) : null,
      atomBFactors: bfac ? bfac.slice(0, n) : null,
      symmetryOps: symmetryConsumed ? undefined : src.symmetryOps,
    };
  };

  /**
   * Replace the working structure with `snap`, re-keying its atoms as
   * `<id>:<k>`. The transforms never list a bond twice, so their bonds are
   * taken as they are.
   */
  const rebuildFrom = (snap: Snapshot, id: string) => {
    load(snap, id, true);
    box = snap.box ? Array.from(snap.box) : null;
    cellTouched = true;
    symmetryConsumed = true;
  };

  /** Take only the positions (and cell) of `snap`: the atoms and their refs are unchanged. */
  const adoptPositions = (snap: Snapshot) => {
    pos.set(snap.positions.subarray(0, snap.nAtoms * 3));
    box = snap.box ? Array.from(snap.box) : null;
  };

  load(src, null, false);

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
        const keep = new Uint8Array(refs.n).fill(1);
        let any = false;
        for (const ref of op.atoms) {
          const i = resolve(ref, "delete_atoms");
          if (i !== null) {
            keep[i] = 0;
            any = true;
          }
        }
        if (!any) break;
        const map = refs.compact(keep);
        let w = 0;
        for (let i = 0; i < map.length; i++) {
          if (map[i] === NONE) continue;
          pos[w * 3] = pos[i * 3];
          pos[w * 3 + 1] = pos[i * 3 + 1];
          pos[w * 3 + 2] = pos[i * 3 + 2];
          elem[w] = elem[i];
          if (chain) chain[w] = chain[i];
          if (bfac) bfac[w] = bfac[i];
          w++;
        }
        // Bonds: drop the ones touching a deleted atom, renumber the rest.
        let wb = 0;
        for (let s = 0; s < nBonds; s++) {
          if (bondDead[s]) continue;
          const a = map[bondA[s]];
          const b = map[bondB[s]];
          if (a === NONE || b === NONE) continue;
          bondA[wb] = a;
          bondB[wb] = b;
          bondOrd[wb] = bondOrd[s];
          bondDead[wb] = 0;
          wb++;
        }
        nBonds = wb;
        nDeadBonds = 0;
        adjOff = null;
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
        const i = resolve(op.a, "delete_bond");
        const j = i === null ? null : resolve(op.b, "delete_bond");
        if (i === null || j === null) break;
        const slot = findBond(i, j);
        if (slot < 0) {
          warnings.push(
            `delete_bond: no bond between ${describeRef(op.a)} and ${describeRef(op.b)} (skipped)`,
          );
          break;
        }
        bondDead[slot] = 1;
        nDeadBonds++;
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
            const n = refs.n;
            const cart = fracToCart(cartToFrac(pos.subarray(0, n * 3), oldInv), op.box);
            pos.set(cart);
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
  const nAtoms = refs.n;
  const { bonds: bondsOut, orders: ordersOut } = liveBonds();

  // Cα backbone: keep the entries whose atom survived, remapped to new indices.
  let caIndices: Uint32Array | undefined;
  let caChainIds: Uint8Array | undefined;
  let caResNums: Uint32Array | undefined;
  let caSsType: Uint8Array | undefined;
  if (src.caIndices) {
    const keep: number[] = [];
    const mapped: number[] = [];
    for (let c = 0; c < src.caIndices.length; c++) {
      const ni = refs.indexOf(src.caIndices[c]);
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
    nBonds: bondsOut.length / 2,
    // Every surviving bond is now asserted by the edit, so downstream code
    // treats the whole set as declared (not distance-inferred) connectivity.
    nFileBonds: bondsOut.length / 2,
    positions: new Float32Array(pos.subarray(0, nAtoms * 3)),
    elements: elem.slice(0, nAtoms),
    bonds: bondsOut,
    bondOrders: ordersOut,
    box: box ? new Float32Array(box) : null,
    boxOrigin: cellTouched ? null : src.boxOrigin,
    atomChainIds: chain ? chain.slice(0, nAtoms) : null,
    atomBFactors: bfac ? bfac.slice(0, nAtoms) : null,
    caIndices,
    caChainIds,
    caResNums,
    caSsType,
    symmetryOps: symmetryConsumed ? undefined : src.symmetryOps,
  };

  let materializedRefs: EditAtomRef[] | null = null;
  return {
    snapshot,
    refAt: (i) => refs.refAt(i),
    get outputRefs() {
      return (materializedRefs ??= refs.toArray());
    },
    warnings,
  };
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
