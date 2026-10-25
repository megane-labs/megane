/**
 * A/B benchmark for the CartoonRenderer per-frame playback path (CRITICAL RULE #10).
 *
 * Run with: `node_modules/.bin/vitest bench tests/ts/renderer/CartoonRenderer.bench.ts`
 *
 * Compares the two ways of advancing a trajectory frame while the cartoon
 * representation is visible:
 *
 *   - "full rebuild per frame" — the PREVIOUS behavior: dispose every ribbon and
 *     reconstruct its geometry (rings, colors, index buffer, BufferGeometry,
 *     material, Mesh) from scratch. Reproduced here via loadSnapshot(), which
 *     runs the same buildChainRibbon() path per chain.
 *   - "in-place update per frame" — the NEW behavior: rewrite only the position
 *     and normal attributes of the existing geometry and flag them for re-upload.
 *
 * The in-place path is expected to be several times faster because it skips all
 * per-frame allocation and the frame-invariant ring/color/index work.
 */

import { bench, describe } from "vitest";
import { CartoonRenderer, SS_COIL, SS_HELIX, SS_SHEET } from "@/renderer/CartoonRenderer";
import type { Snapshot } from "@/types";

/** Build a multi-chain protein-like snapshot with a mix of secondary structure. */
function makeProteinSnapshot(nChains: number, residuesPerChain: number): Snapshot {
  const nCa = nChains * residuesPerChain;
  const positions = new Float32Array(nCa * 3);
  const caIndices = new Uint32Array(nCa);
  const caChainIds = new Uint8Array(nCa);
  const caResNums = new Int32Array(nCa);
  const caSsType = new Uint8Array(nCa);

  let a = 0;
  for (let c = 0; c < nChains; c++) {
    for (let r = 0; r < residuesPerChain; r++) {
      // A gently curved backbone so Frenet frames are non-degenerate.
      positions[a * 3] = r * 3.8 + c * 5;
      positions[a * 3 + 1] = Math.sin(r * 0.3) * 6;
      positions[a * 3 + 2] = Math.cos(r * 0.3) * 6 + c * 40;
      caIndices[a] = a;
      caChainIds[a] = 65 + c;
      caResNums[a] = r + 1;
      // Repeating coil / helix / sheet blocks.
      const block = Math.floor(r / 6) % 3;
      caSsType[a] = block === 0 ? SS_COIL : block === 1 ? SS_HELIX : SS_SHEET;
      a++;
    }
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
    caIndices,
    caChainIds,
    caResNums,
    caSsType,
  };
}

/** Produce a distinct frame's coordinates by wobbling the backbone over time. */
function framePositions(base: Float32Array, t: number): Float32Array {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 3) {
    out[i] = base[i];
    out[i + 1] = base[i + 1] + Math.sin(t + i * 0.01) * 0.5;
    out[i + 2] = base[i + 2] + Math.cos(t + i * 0.01) * 0.5;
  }
  return out;
}

describe("CartoonRenderer per-frame playback (3 chains × 250 residues)", () => {
  const snap = makeProteinSnapshot(3, 250);

  // Pre-generate a handful of frames so neither case pays generation cost inline.
  const frames = Array.from({ length: 8 }, (_, i) => framePositions(snap.positions, i));

  const rebuildRenderer = new CartoonRenderer();
  rebuildRenderer.loadSnapshot(snap);
  let rebuildFrame = 0;

  const inPlaceRenderer = new CartoonRenderer();
  inPlaceRenderer.loadSnapshot(snap);
  let inPlaceFrame = 0;

  bench("full rebuild per frame (previous behavior)", () => {
    // loadSnapshot rebuilds every chain's geometry — the pre-change cost.
    rebuildRenderer.loadSnapshot({ ...snap, positions: frames[rebuildFrame % frames.length] });
    rebuildFrame++;
  });

  bench("in-place update per frame (new behavior)", () => {
    inPlaceRenderer.updatePositions(frames[inPlaceFrame % frames.length]);
    inPlaceFrame++;
  });
});
