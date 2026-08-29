import type { PipelineData, VolumetricData, MeshData, IsosurfaceParams } from "../types";
import { marchingCubes } from "./marchingCubes";
import { colorVerticesByVolume } from "./volumeColor";
import { hexColorToRgb } from "../../renderer/alphaSurface";

/**
 * Isosurface executor.
 *
 * Reads a VolumetricData input, runs marching cubes at the configured iso
 * level, and outputs a MeshData packet suitable for the Viewport's mesh port.
 *
 * When showNegative is true a second isosurface at −isoLevel is computed and
 * merged into the same MeshData with a different color (dual contour for ESP
 * maps or molecular orbitals).
 *
 * When colorMode is "volume" and a second volumetric stream is connected to
 * the `colorVolumetric` input, vertex colors are instead produced by sampling
 * that volume at each vertex and mapping the values through the configured
 * colormap (e.g. ESP painted onto a charge-density isosurface). Without a
 * connected color volume the node falls back to the solid colors.
 */
export function executeIsosurface(
  params: IsosurfaceParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();

  const volInput = inputs.get("volumetric")?.[0] as VolumetricData | undefined;
  if (!volInput || volInput.type !== "volumetric") return outputs;

  const rawColorVol = inputs.get("colorVolumetric")?.[0] as VolumetricData | undefined;
  const colorVol = rawColorVol?.type === "volumetric" ? rawColorVol : undefined;

  const { nx, ny, nz, origin, step, data } = volInput;
  const { isoLevel, color, opacity, showNegative, negativeColor } = params;

  // ── Positive isosurface ────────────────────────────────────────────────────
  const pos = marchingCubes(data, nx, ny, nz, origin, step, isoLevel);
  const nVertsPos = pos.positions.length / 3;

  // ── Negative isosurface (optional) ────────────────────────────────────────
  let nVertsNeg = 0;
  let neg: ReturnType<typeof marchingCubes> | null = null;
  if (showNegative && isoLevel > 0) {
    neg = marchingCubes(data, nx, ny, nz, origin, step, -isoLevel);
    nVertsNeg = neg.positions.length / 3;
  }

  const totalVerts = nVertsPos + nVertsNeg;

  if (totalVerts === 0) {
    // No surface at the requested iso level — emit an empty mesh so downstream
    // nodes don't receive a null.
    const empty: MeshData = {
      type: "mesh",
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      opacity,
      showEdges: false,
      edgePositions: null,
      edgeColor: "#888888",
      edgeWidth: 1,
    };
    outputs.set("mesh", empty);
    return outputs;
  }

  // ── Merge geometry ─────────────────────────────────────────────────────────
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 4);
  const indices = new Uint32Array(totalVerts);

  positions.set(pos.positions, 0);
  normals.set(pos.normals, 0);
  if (neg) {
    positions.set(neg.positions, nVertsPos * 3);
    normals.set(neg.normals, nVertsPos * 3);
  }

  for (let i = 0; i < totalVerts; i++) indices[i] = i;

  // Fill vertex colors: volume-mapped when requested and possible, solid
  // otherwise. colorVerticesByVolume returns null when the color volume is
  // unusable (degenerate grid), in which case the solid path takes over.
  const volumeColored =
    params.colorMode === "volume" && colorVol
      ? colorVerticesByVolume(
          positions,
          colors,
          opacity,
          colorVol,
          params.colormap,
          params.colorRange,
        ) !== null
      : false;

  if (!volumeColored) {
    const [pr, pg, pb] = hexColorToRgb(color);
    for (let i = 0; i < nVertsPos; i++) {
      colors[i * 4] = pr;
      colors[i * 4 + 1] = pg;
      colors[i * 4 + 2] = pb;
      colors[i * 4 + 3] = opacity;
    }
    if (nVertsNeg > 0) {
      const [nr, ng, nb] = hexColorToRgb(negativeColor);
      for (let i = nVertsPos; i < totalVerts; i++) {
        colors[i * 4] = nr;
        colors[i * 4 + 1] = ng;
        colors[i * 4 + 2] = nb;
        colors[i * 4 + 3] = opacity;
      }
    }
  }

  const mesh: MeshData = {
    type: "mesh",
    positions,
    indices,
    normals,
    colors,
    opacity,
    showEdges: false,
    edgePositions: null,
    edgeColor: "#888888",
    edgeWidth: 1,
  };
  outputs.set("mesh", mesh);
  return outputs;
}
