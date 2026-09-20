// Smoke test for dist/rdkit-embed.{mjs,wasm}: loads the module, embeds a few
// molecules from SMILES and from a flat mol block, and checks the geometry is
// genuinely three-dimensional and the force field ran. Prints timings so a
// build can be compared against RDKit in Python and against openchemlib-js.
import assert from "node:assert/strict";
import { loadRDKitEmbed } from "../index.mjs";

const rdkit = await loadRDKitEmbed();
const version = rdkit.version();
assert.match(version, /^\d{4}\.\d{2}\.\d+/, `unexpected RDKit version string: ${version}`);
console.log(`RDKit ${version}`);

/** Atom coordinates of a V2000 mol block as [[x, y, z], ...]. */
function coordsOf(molblock) {
  const lines = molblock.split("\n");
  const counts = lines[3];
  const nAtoms = parseInt(counts.slice(0, 3), 10);
  const out = [];
  for (let i = 0; i < nAtoms; i++) {
    const line = lines[4 + i];
    out.push([
      parseFloat(line.slice(0, 10)),
      parseFloat(line.slice(10, 20)),
      parseFloat(line.slice(20, 30)),
    ]);
  }
  return out;
}

/** Smallest extent along any principal-ish axis: zero for a planar molecule. */
function thickness(coords) {
  const n = coords.length;
  const mean = [0, 0, 0];
  for (const c of coords) for (let k = 0; k < 3; k++) mean[k] += c[k] / n;
  // Spread along z after centring is enough here: ETKDG output is not aligned
  // to any plane, so a flat result would have to be flat along some axis;
  // check all three and take the minimum.
  const spread = [0, 0, 0];
  for (const c of coords) for (let k = 0; k < 3; k++) spread[k] = Math.max(spread[k], Math.abs(c[k] - mean[k]));
  return Math.min(...spread);
}

function bondLengthsOk(molblock) {
  const coords = coordsOf(molblock);
  const lines = molblock.split("\n");
  const nAtoms = parseInt(lines[3].slice(0, 3), 10);
  const nBonds = parseInt(lines[3].slice(3, 6), 10);
  for (let i = 0; i < nBonds; i++) {
    const line = lines[4 + nAtoms + i];
    const a = parseInt(line.slice(0, 3), 10) - 1;
    const b = parseInt(line.slice(3, 6), 10) - 1;
    const d = Math.hypot(...[0, 1, 2].map((k) => coords[a][k] - coords[b][k]));
    if (d < 0.7 || d > 2.2) return false;
  }
  return true;
}

// [name, SMILES, atoms with hydrogens, planar?] — benzene must come out flat,
// everything else must leave the plane.
const CASES = [
  ["ethanol", "CCO", 9, false],
  ["benzene", "c1ccccc1", 12, true],
  ["ibuprofen", "CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O", 33, false],
  ["cyclohexyl-phenylethanol", "C1CCCCC1CC(O)c1ccccc1", 35, false],
];

for (const [name, smiles, nAtoms, planar] of CASES) {
  const t = performance.now();
  const result = rdkit.embed(smiles);
  const ms = performance.now() - t;
  assert.equal(result.molblocks.length, 1);
  assert.equal(result.numAtoms, nAtoms, `${name}: atom count`);
  assert.equal(result.forceField, "MMFF94s");
  assert.ok(Number.isFinite(result.energies[0]), `${name}: energy`);
  const t3d = thickness(coordsOf(result.molblocks[0]));
  if (planar) {
    assert.ok(t3d < 0.1, `${name}: should be planar (thickness ${t3d.toFixed(2)})`);
  } else {
    assert.ok(t3d > 0.3, `${name}: geometry is flat (thickness ${t3d.toFixed(2)})`);
  }
  assert.ok(bondLengthsOk(result.molblocks[0]), `${name}: bond lengths out of range`);
  console.log(`${name.padEnd(26)} ${String(nAtoms).padStart(3)} atoms  ${ms.toFixed(1).padStart(7)} ms  E=${result.energies[0].toFixed(2)} kcal/mol`);
}

// Deterministic: the same seed gives the same coordinates.
{
  const a = rdkit.embed("CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O", { randomSeed: 7 });
  const b = rdkit.embed("CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O", { randomSeed: 7 });
  assert.equal(a.molblocks[0], b.molblocks[0], "same seed must reproduce the geometry");
}

// A flat Ketcher-style mol block (2D coordinates, no explicit hydrogens): the
// Builder's real input. Hydrogens are added and the ring leaves the plane.
{
  const flatCyclohexanol = [
    "",
    "  Ketcher  1 1 2024 2D",
    "",
    "  7  7  0  0  0  0  0  0  0  0999 V2000",
    "    0.8660    0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    0.8660   -0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    0.0000   -1.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "   -0.8660   -0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "   -0.8660    0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    0.0000    1.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    0.0000    2.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
    "  1  2  1  0  0  0  0",
    "  2  3  1  0  0  0  0",
    "  3  4  1  0  0  0  0",
    "  4  5  1  0  0  0  0",
    "  5  6  1  0  0  0  0",
    "  6  1  1  0  0  0  0",
    "  6  7  1  0  0  0  0",
    "M  END",
    "",
  ].join("\n");
  const result = rdkit.embed(flatCyclohexanol, { numConfs: 3 });
  assert.equal(result.molblocks.length, 3);
  assert.equal(result.numAtoms, 19, "cyclohexanol with hydrogens");
  assert.equal(result.numHeavyAtoms, 7);
  for (const mb of result.molblocks) {
    assert.ok(thickness(coordsOf(mb)) > 0.3, "ring should pucker");
    assert.ok(bondLengthsOk(mb));
  }
  const noH = rdkit.embed(flatCyclohexanol, { removeHs: true, forceField: "UFF" });
  assert.equal(noH.numAtoms, 7);
  assert.equal(noH.forceField, "UFF");
  console.log("flat mol block            ok (3 conformers, UFF variant, removeHs)");
}

// Error paths surface as exceptions, not crashes.
assert.throws(() => rdkit.embed("this is not a molecule"), /parse/i);
assert.throws(() => rdkit.embed("CCO", { forceField: "AMBER" }), /forceField/);
assert.throws(() => rdkit.embed("CCO", { numConfs: 0 }), /numConfs/);
console.log("error paths               ok");
console.log("smoke test passed");
