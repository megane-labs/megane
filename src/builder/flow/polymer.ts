/**
 * The Polymer chain block's chemistry: a repeat unit written as SMILES with
 * two `*` attachment points becomes the SMILES of a linear chain, which
 * RDKit embeds in 3D like any other SMILES block.
 *
 * A repeat unit `*X*` whose head `*` opens the string and whose tail `*`
 * closes it on the main chain (outside every branch) chains by plain
 * concatenation: `XXX…` bonds each unit's first atom to the previous unit's
 * last main-chain atom, and the two chain ends keep the hydrogens RDKit adds.
 * Ring-closure digits are reused safely as long as every ring closes inside
 * its unit, which `chainSmiles` checks.
 */

/** A ready-made repeat unit for the block's preset list. */
export interface PolymerPreset {
  id: string;
  label: string;
  repeatUnit: string;
  /** Residue name the chain gets (≤ 4 characters, as packmol tools truncate it). */
  name: string;
}

export const POLYMER_PRESETS: readonly PolymerPreset[] = [
  { id: "pe", label: "Polyethylene (PE)", repeatUnit: "*CC*", name: "PE" },
  { id: "pp", label: "Polypropylene (PP)", repeatUnit: "*CC(C)*", name: "PP" },
  { id: "ps", label: "Polystyrene (PS)", repeatUnit: "*CC(c1ccccc1)*", name: "PS" },
  { id: "pvc", label: "Poly(vinyl chloride) (PVC)", repeatUnit: "*CC(Cl)*", name: "PVC" },
  { id: "ptfe", label: "PTFE", repeatUnit: "*C(F)(F)C(F)(F)*", name: "PTFE" },
  { id: "pmma", label: "PMMA", repeatUnit: "*CC(C)(C(=O)OC)*", name: "PMMA" },
  { id: "peo", label: "Poly(ethylene oxide) (PEO)", repeatUnit: "*CCO*", name: "PEO" },
  { id: "pva", label: "Poly(vinyl alcohol) (PVA)", repeatUnit: "*CC(O)*", name: "PVA" },
  { id: "nylon6", label: "Nylon 6", repeatUnit: "*NCCCCCC(=O)*", name: "NY6" },
  {
    id: "pet",
    label: "PET",
    repeatUnit: "*OCCOC(=O)c1ccc(cc1)C(=O)*",
    name: "PET",
  },
];

/** Longest chain the block builds: RDKit embeds the whole chain at once. */
export const MAX_POLYMER_UNITS = 100;
/** Most heavy atoms a chain may have, so one embedding stays within the worker's time. */
export const MAX_POLYMER_HEAVY_ATOMS = 1200;

/** Atoms of a SMILES string: bracket atoms, the two-letter organic subset, then one letter. */
const ATOM_TOKEN = /\[[^\]]*\]|Cl|Br|[BCNOPSFIbcnops]/g;

/** A repeat unit read for chaining: what goes between the two `*`, and its heavy atoms. */
export interface RepeatUnit {
  /** The unit without its attachment points, e.g. `CC(c1ccccc1)`. */
  body: string;
  /** Heavy atoms in one unit (every atom of `body`; hydrogens come from RDKit). */
  heavyAtoms: number;
}

/** `[*]` and `[*:1]` written as plain `*`, whitespace dropped. */
function normalize(smiles: string): string {
  return smiles.replace(/\[\*(?::\d+)?\]/g, "*").replace(/\s+/g, "");
}

/** Read a repeat unit, or throw the reason it cannot be chained. */
export function parseRepeatUnit(smiles: string): RepeatUnit {
  const s = normalize(smiles);
  if (!s) throw new Error("Enter the repeat unit as SMILES with two * ends, e.g. *CC*.");
  const stars = s.split("*").length - 1;
  if (stars !== 2 || !s.startsWith("*") || !s.endsWith("*")) {
    throw new Error(
      "Write the repeat unit with one * at the start (head) and one at the end (tail), e.g. *CC(C)*.",
    );
  }
  let body = s.slice(1, -1);
  // An explicit single bond to the neighbouring unit is the same as none.
  if (body.startsWith("-")) body = body.slice(1);
  if (body.endsWith("-")) body = body.slice(0, -1);
  if (/^[=#$:/\\]|[=#$:/\\]$/.test(body)) {
    throw new Error("Only single bonds between repeat units are supported.");
  }
  // Outside bracket atoms: branches must close and every ring must close in the unit.
  const bare = body.replace(/\[[^\]]*\]/g, "A");
  let depth = 0;
  for (const ch of bare) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) break;
  }
  if (depth !== 0) {
    throw new Error("The tail * must be on the main chain: close every branch before it.");
  }
  const rings = new Map<string, number>();
  for (const m of bare.matchAll(/%\d{2}|\d/g)) rings.set(m[0], (rings.get(m[0]) ?? 0) + 1);
  if ([...rings.values()].some((n) => n % 2 !== 0)) {
    throw new Error("Every ring must close within one repeat unit.");
  }
  const heavyAtoms = body.match(ATOM_TOKEN)?.length ?? 0;
  if (heavyAtoms === 0) throw new Error("The repeat unit has no atoms between its * ends.");
  return { body, heavyAtoms };
}

/** SMILES of a chain of `length` units, hydrogen-capped at both ends. Throws on a bad unit or length. */
export function chainSmiles(
  repeatUnit: string,
  length: number,
): { smiles: string; unit: RepeatUnit } {
  if (!Number.isInteger(length) || length < 1 || length > MAX_POLYMER_UNITS) {
    throw new Error(`Repeat units must be a whole number from 1 to ${MAX_POLYMER_UNITS}.`);
  }
  const unit = parseRepeatUnit(repeatUnit);
  if (unit.heavyAtoms * length > MAX_POLYMER_HEAVY_ATOMS) {
    throw new Error(
      `${unit.heavyAtoms * length} heavy atoms is too long a chain to embed at once (at most ${MAX_POLYMER_HEAVY_ATOMS}); use fewer repeat units.`,
    );
  }
  return { smiles: unit.body.repeat(length), unit };
}

/** A residue name from a molecule name: up to 4 letters or digits, upper case. */
export function residueName(name: string, fallback = "MOL"): string {
  const out = name
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();
  return out || fallback;
}

/**
 * `RESNAME<unit>` labels for an embedded chain, numbering the repeat units
 * from 1. RDKit keeps the SMILES atom order and appends the hydrogens it
 * adds, so heavy atom `i` belongs to unit `⌊i / heavyAtoms⌋` and each
 * hydrogen to the unit of the atom it is bonded to. Null when the embedded
 * structure does not have that layout.
 */
export function polymerLabels(
  elements: ArrayLike<number>,
  bonds: ArrayLike<number>,
  unit: RepeatUnit,
  length: number,
  resname: string,
): string[] | null {
  const heavy = unit.heavyAtoms * length;
  if (elements.length < heavy) return null;
  const units = new Int32Array(elements.length).fill(-1);
  for (let i = 0; i < heavy; i++) {
    if (elements[i] === 1) return null;
    units[i] = Math.floor(i / unit.heavyAtoms);
  }
  for (let b = 0; b + 1 < bonds.length; b += 2) {
    const i = bonds[b];
    const j = bonds[b + 1];
    if (units[i] < 0 && units[j] >= 0) units[i] = units[j];
    else if (units[j] < 0 && units[i] >= 0) units[j] = units[i];
  }
  const out: string[] = [];
  for (const u of units) {
    if (u < 0) return null;
    out.push(`${resname}${u + 1}`);
  }
  return out;
}
