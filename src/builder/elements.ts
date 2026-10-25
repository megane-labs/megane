/**
 * Elements for the Builder's tool settings: grouping a structure's atoms by
 * element (the "select by element" chips), reading what the user typed into
 * the element field, the elements picked recently, and the names and
 * families behind the periodic table.
 */

import { create } from "zustand";
import { ELEMENT_SYMBOLS, getElementSymbol } from "../constants";

/** The highest atomic number the element field accepts. */
export const MAX_Z = 118;

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

/** English names of the elements the periodic table shows (Z 1–118). */
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
  "Francium", "Radium", "Actinium", "Thorium", "Protactinium", "Uranium", "Neptunium",
  "Plutonium", "Americium", "Curium", "Berkelium", "Californium", "Einsteinium", "Fermium",
  "Mendelevium", "Nobelium", "Lawrencium", "Rutherfordium", "Dubnium", "Seaborgium", "Bohrium",
  "Hassium", "Meitnerium", "Darmstadtium", "Roentgenium", "Copernicium", "Nihonium",
  "Flerovium", "Moscovium", "Livermorium", "Tennessine", "Oganesson",
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
assign("halogen", [9, 17, 35, 53, 85, 117]);
assign("noble-gas", [2, 10, 18, 36, 54, 86, 118]);
assign("post-transition", [13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116]);

/** The family of element `z` (Z 1–118; the rest of the d block is transition). */
export function elementFamily(z: number): ElementFamily {
  const f = FAMILY_OF[z];
  if (f) return f;
  if (z >= 57 && z <= 71) return "lanthanide";
  if (z >= 89 && z <= 103) return "actinide";
  return "transition";
}

const Z_OF_SYMBOL = new Map(
  Object.entries(ELEMENT_SYMBOLS).map(([z, sym]) => [sym.toLowerCase(), Number(z)]),
);

/**
 * The element a user typed: an atomic number (1–{@link MAX_Z}) or a symbol
 * in any case ("Fe", "fe", "FE"); null when it is neither.
 */
export function parseElement(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const z = Number(t);
    return z >= 1 && z <= MAX_Z ? z : null;
  }
  return Z_OF_SYMBOL.get(t.toLowerCase()) ?? null;
}

/** How many recently picked elements the tool settings remember. */
export const RECENT_LIMIT = 6;

export interface RecentElements {
  /** Most recent first, without repeats. */
  recent: number[];
  /** Remember `z` as the most recent pick. */
  remember: (z: number) => void;
}

/**
 * The elements picked from the periodic table or typed into the element
 * field this session, so a second Fe is one click away. Shared by every
 * Builder on the page and kept only in memory.
 */
export const useRecentElements = create<RecentElements>((set) => ({
  recent: [],
  remember: (z) =>
    set((s) => ({ recent: [z, ...s.recent.filter((r) => r !== z)].slice(0, RECENT_LIMIT) })),
}));
