/**
 * Drag-recompute benchmark (CRITICAL RULE #10): a 2000-atom structure with a
 * 300-op history, then a 100-step drag of 20 atoms through `setDragOps`, the
 * path every pointer move of a Select / Move drag takes. Also times a plain
 * `pushOp` on the same history for reference.
 *
 *   npx vitest bench --run tests/ts/builder/drag.bench.ts
 */

import { bench, describe } from "vitest";
import { createBuilderStore } from "@/builder/store";
import { moveOps } from "@/builder/manipulate";
import type { EditAtomRef, EditOp } from "@/pipeline/types";
import type { Snapshot } from "@/types";

const N = 2000;
const HISTORY = 300;
const MOVES = 100;

function chain(n: number): Snapshot {
  const positions = new Float32Array(n * 3);
  const bonds = new Uint32Array((n - 1) * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (i % 50) * 1.5;
    positions[i * 3 + 1] = Math.floor(i / 50) * 1.5;
  }
  for (let i = 0; i < n - 1; i++) {
    bonds[i * 2] = i;
    bonds[i * 2 + 1] = i + 1;
  }
  return {
    nAtoms: n,
    nBonds: n - 1,
    nFileBonds: n - 1,
    positions,
    elements: new Uint8Array(n).fill(6),
    bonds,
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function history(): EditOp[] {
  const ops: EditOp[] = [];
  for (let k = 0; k < HISTORY; k++) {
    switch (k % 4) {
      case 0:
        ops.push({ op: "add_atom", id: `b${k}`, element: 8, position: [k, 0, 5], bondTo: k });
        break;
      case 1:
        ops.push({ op: "move_atoms", atoms: [k, k + 1], delta: [0.01, 0, 0] });
        break;
      case 2:
        ops.push({ op: "set_element", atoms: [k], element: 7 });
        break;
      default:
        ops.push({ op: "add_bond", a: k, b: k + 2, order: 1 });
    }
  }
  return ops;
}

function setup() {
  const api = createBuilderStore();
  api.getState().openStructure(chain(N), null, "chain.xyz");
  api.getState().pushOps(history());
  return api;
}

describe(`drag: ${N} atoms, ${HISTORY}-op history, ${MOVES} moves of 20 atoms`, () => {
  // One document for every run: each run is the same drag from the same base.
  const api = setup();
  const base = api.getState().edits.length;
  const atoms = Array.from({ length: 20 }, (_, k) => 500 + k);
  const refs = new Map<number, EditAtomRef>(atoms.map((i) => [i, api.getState().result!.refAt(i)]));

  bench(
    "setDragOps x100 (one drag)",
    () => {
      for (let m = 1; m <= MOVES; m++) {
        const d = new Map<number, [number, number, number]>(
          atoms.map((i) => [i, [m * 0.01, 0, 0]]),
        );
        api.getState().setDragOps(base, moveOps(d, refs));
      }
      api.getState().setDragOps(base, []);
    },
    { iterations: 20, warmupIterations: 3 },
  );

  bench(
    "pushOp + undo on the history",
    () => {
      api.getState().pushOp({ op: "move_atoms", atoms: [3], delta: [0.01, 0, 0] });
      api.getState().undo();
    },
    { iterations: 50, warmupIterations: 5 },
  );
});
