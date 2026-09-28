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
