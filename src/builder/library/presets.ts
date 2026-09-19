/**
 * Molecules the library ships with: small, common species with real 3D
 * geometries (experimental bond lengths and angles), centred at the origin.
 * Presets are read-only; the user's own molecules live in the library store.
 */

import { centered, formulaOf } from "./fragment";
import type { LibraryMolecule } from "./types";

type Atom = [element: number, x: number, y: number, z: number];
type Bond = [i: number, j: number, order?: number];

function preset(slug: string, name: string, atoms: Atom[], bonds: Bond[]): LibraryMolecule {
  const geometry = centered({
    elements: atoms.map((a) => a[0]),
    positions: atoms.flatMap((a) => [a[1], a[2], a[3]]),
    bonds: bonds.map(([i, j]) => [i, j]),
    bondOrders: bonds.some((b) => (b[2] ?? 1) !== 1) ? bonds.map((b) => b[2] ?? 1) : undefined,
  });
  if (!geometry.bondOrders) delete geometry.bondOrders;
  return {
    id: `preset:${slug}`,
    name,
    formula: formulaOf(geometry.elements),
    origin: "preset",
    ...geometry,
  };
}

const H = 1;
const C = 6;
const N = 7;
const O = 8;

// Tetrahedral C–H: 1.09 Å at 109.5°, i.e. x = −0.364 and radius 1.028 about the axis.
const T_X = -0.364;
const T_R = 1.028;
const T_Y60 = T_R * Math.cos(Math.PI / 3);
const T_Z60 = T_R * Math.sin(Math.PI / 3);

/** Benzene: C–C 1.39 Å, C–H 1.08 Å, Kekulé bond orders. */
function benzene(): LibraryMolecule {
  const atoms: Atom[] = [];
  const bonds: Bond[] = [];
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push([C, 1.39 * Math.cos(t), 1.39 * Math.sin(t), 0]);
  }
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push([H, 2.47 * Math.cos(t), 2.47 * Math.sin(t), 0]);
    bonds.push([k, (k + 1) % 6, k % 2 === 0 ? 2 : 1]);
    bonds.push([k, 6 + k]);
  }
  return preset("benzene", "Benzene", atoms, bonds);
}

/** The molecules the library starts with, in display order. */
export const PRESET_MOLECULES: readonly LibraryMolecule[] = [
  preset(
    "water",
    "Water",
    [
      [O, 0, 0, 0],
      [H, 0.7572, 0.5865, 0],
      [H, -0.7572, 0.5865, 0],
    ],
    [
      [0, 1],
      [0, 2],
    ],
  ),
  preset(
    "ammonia",
    "Ammonia",
    [
      [N, 0, 0, 0],
      [H, 0.9377, 0, -0.3816],
      [H, -0.4689, 0.8121, -0.3816],
      [H, -0.4689, -0.8121, -0.3816],
    ],
    [
      [0, 1],
      [0, 2],
      [0, 3],
    ],
  ),
  preset(
    "methane",
    "Methane",
    [
      [C, 0, 0, 0],
      [H, 0.6276, 0.6276, 0.6276],
      [H, -0.6276, -0.6276, 0.6276],
      [H, -0.6276, 0.6276, -0.6276],
      [H, 0.6276, -0.6276, -0.6276],
    ],
    [
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ],
  ),
  preset(
    "carbon-dioxide",
    "Carbon dioxide",
    [
      [C, 0, 0, 0],
      [O, 1.16, 0, 0],
      [O, -1.16, 0, 0],
    ],
    [
      [0, 1, 2],
      [0, 2, 2],
    ],
  ),
  preset(
    "methanol",
    "Methanol",
    [
      [C, 0, 0, 0],
      [O, 1.427, 0, 0],
      [H, 1.737, 0.904, 0],
      [H, T_X, -T_R, 0],
      [H, T_X, T_Y60, T_Z60],
      [H, T_X, T_Y60, -T_Z60],
    ],
    [
      [0, 1],
      [1, 2],
      [0, 3],
      [0, 4],
      [0, 5],
    ],
  ),
  preset(
    "ethanol",
    "Ethanol",
    [
      [C, 0, 0, 0],
      [C, 1.53, 0, 0],
      [O, 2.007, 1.348, 0],
      [H, 2.967, 1.331, 0],
      [H, 1.893, -0.514, 0.89],
      [H, 1.893, -0.514, -0.89],
      [H, T_X, T_Y60, T_Z60],
      [H, T_X, -T_R, 0],
      [H, T_X, T_Y60, -T_Z60],
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [1, 4],
      [1, 5],
      [0, 6],
      [0, 7],
      [0, 8],
    ],
  ),
  benzene(),
  preset(
    "hydrogen",
    "Hydrogen (H₂)",
    [
      [H, 0.37, 0, 0],
      [H, -0.37, 0, 0],
    ],
    [[0, 1]],
  ),
  preset(
    "nitrogen",
    "Nitrogen (N₂)",
    [
      [N, 0.549, 0, 0],
      [N, -0.549, 0, 0],
    ],
    [[0, 1, 3]],
  ),
  preset(
    "oxygen",
    "Oxygen (O₂)",
    [
      [O, 0.604, 0, 0],
      [O, -0.604, 0, 0],
    ],
    [[0, 1, 2]],
  ),
];
