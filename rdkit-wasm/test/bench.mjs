// Timing harness for dist/rdkit-embed.wasm: embed + minimise a few molecules
// and print warm timings, so a build can be compared against RDKit in Python
// (see README) or against another engine. Not a test; nothing is asserted.
import { loadRDKitEmbed } from "../index.mjs";

const rdkit = await loadRDKitEmbed();
console.log(`RDKit ${rdkit.version()} (wasm)`);

const CASES = [
  ["ethanol", "CCO"],
  ["benzene", "c1ccccc1"],
  ["ibuprofen", "CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O"],
  ["cyclohexyl-phenylethanol", "C1CCCCC1CC(O)c1ccccc1"],
  [
    "erythromycin-like macrocycle",
    "CC[C@H]1OC(=O)[C@H](C)[C@@H](O)[C@H](C)[C@@H](O)[C@](C)(O)C[C@@H](C)C[C@@H](C)C(=O)[C@H](C)[C@@H](O)[C@]1(C)O",
  ],
];

function time(fn) {
  const t = performance.now();
  const r = fn();
  return [performance.now() - t, r];
}

for (const [name, smiles] of CASES) {
  rdkit.embed(smiles); // warm-up (first call pays for lazy init)
  const [embedMs, r1] = time(() => rdkit.embed(smiles, { forceField: "none" }));
  const [totalMs] = time(() => rdkit.embed(smiles, { forceField: "MMFF94s" }));
  console.log(
    `${name.padEnd(30)} atoms=${String(r1.numAtoms).padStart(3)} n= 1 embed=${embedMs.toFixed(1).padStart(7)} ms  mmff=${(totalMs - embedMs).toFixed(1).padStart(7)} ms`,
  );
}
for (const [name, smiles] of CASES.slice(2, 4)) {
  const [embedMs, r1] = time(() => rdkit.embed(smiles, { numConfs: 10, forceField: "none" }));
  const [totalMs] = time(() => rdkit.embed(smiles, { numConfs: 10, forceField: "MMFF94s" }));
  console.log(
    `${name.padEnd(30)} atoms=${String(r1.numAtoms).padStart(3)} n=10 embed=${embedMs.toFixed(1).padStart(7)} ms  mmff=${(totalMs - embedMs).toFixed(1).padStart(7)} ms`,
  );
}
