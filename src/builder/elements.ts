/** Grouping a structure's atoms by element, for the "select by element" chips. */

import { getElementSymbol } from "../constants";

/** Atom indices of each element, in Hill order (C, H, then alphabetical). */
export function elementGroups(elements: ArrayLike<number>): { z: number; atoms: number[] }[] {
  const byZ = new Map<number, number[]>();
  for (let i = 0; i < elements.length; i++) {
    const list = byZ.get(elements[i]) ?? [];
    list.push(i);
    byZ.set(elements[i], list);
  }
  const sym = (z: number) => getElementSymbol(z);
  const rank = (z: number) => (z === 6 ? 0 : z === 1 && byZ.has(6) ? 1 : 2);
  return [...byZ.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || sym(a).localeCompare(sym(b)))
    .map(([z, atoms]) => ({ z, atoms }));
}

/** English names of the elements the periodic table shows (Z 1–92). */
// prettier-ignore
export const ELEMENT_NAMES: readonly string[] = [
  "",
  "Hydrogen", "Helium", "Lithium", "Beryllium", "Boron", "Carbon", "Nitrogen", "Oxygen",
  "Fluorine", "Neon", "Sodium", "Magnesium", "Aluminium", "Silicon", "Phosphorus", "Sulfur",
  "Chlorine", "Argon", "Potassium", "Calcium", "Scandium", "Titanium", "Vanadium", "Chromium",
  "Manganese", "Iron", "Cobalt", "Nickel", "Copper", "Zinc", "Gallium", "Germanium",
  "Arsenic", "Selenium", "Bromine", "Krypton", "Rubidium", "Strontium", "Yttrium", "Zirconium",
  "Niobium", "Molybdenum", "Technetium", "Ruthenium", "Rhodium", "Palladium", "Silver", "Cadmium",
  "Indium", "Tin", "Antimony", "Tellurium", "Iodine", "Xenon", "Caesium", "Barium",
  "Lanthanum", "Cerium", "Praseodymium", "Neodymium", "Promethium", "Samarium", "Europium",
  "Gadolinium", "Terbium", "Dysprosium", "Holmium", "Erbium", "Thulium", "Ytterbium",
  "Lutetium", "Hafnium", "Tantalum", "Tungsten", "Rhenium", "Osmium", "Iridium", "Platinum",
  "Gold", "Mercury", "Thallium", "Lead", "Bismuth", "Polonium", "Astatine", "Radon",
  "Francium", "Radium", "Actinium", "Thorium", "Protactinium", "Uranium",
];

export type ElementFamily =
  | "alkali"
  | "alkaline-earth"
  | "transition"
  | "post-transition"
  | "metalloid"
  | "nonmetal"
  | "halogen"
  | "noble-gas"
  | "lanthanide"
  | "actinide";

/** Each family's label and hue (an "r, g, b" triple the table tints with). */
export const FAMILIES: Record<ElementFamily, { label: string; rgb: string }> = {
  alkali: { label: "Alkali metal", rgb: "239, 68, 68" },
  "alkaline-earth": { label: "Alkaline earth metal", rgb: "249, 115, 22" },
  transition: { label: "Transition metal", rgb: "234, 179, 8" },
  "post-transition": { label: "Post-transition metal", rgb: "20, 184, 166" },
  metalloid: { label: "Metalloid", rgb: "34, 197, 94" },
  nonmetal: { label: "Nonmetal", rgb: "59, 130, 246" },
  halogen: { label: "Halogen", rgb: "99, 102, 241" },
  "noble-gas": { label: "Noble gas", rgb: "168, 85, 247" },
  lanthanide: { label: "Lanthanide", rgb: "236, 72, 153" },
  actinide: { label: "Actinide", rgb: "244, 63, 94" },
};

const FAMILY_OF: Partial<Record<number, ElementFamily>> = {};
const assign = (family: ElementFamily, zs: number[]) => zs.forEach((z) => (FAMILY_OF[z] = family));
assign("alkali", [3, 11, 19, 37, 55, 87]);
assign("alkaline-earth", [4, 12, 20, 38, 56, 88]);
assign("metalloid", [5, 14, 32, 33, 51, 52]);
assign("nonmetal", [1, 6, 7, 8, 15, 16, 34]);
assign("halogen", [9, 17, 35, 53, 85]);
assign("noble-gas", [2, 10, 18, 36, 54, 86]);
assign("post-transition", [13, 31, 49, 50, 81, 82, 83, 84]);

/** The family of element `z` (Z 1–118; the rest of the d block is transition). */
export function elementFamily(z: number): ElementFamily {
  const f = FAMILY_OF[z];
  if (f) return f;
  if (z >= 57 && z <= 71) return "lanthanide";
  if (z >= 89 && z <= 103) return "actinide";
  return "transition";
}
