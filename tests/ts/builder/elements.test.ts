/** Element names and families behind the periodic table. */

import { describe, it, expect } from "vitest";
import { ELEMENT_NAMES, FAMILIES, elementFamily } from "@/builder/elements";
import { TABLE_MAX_Z } from "@/builder/PeriodicTable";

describe("element names and families", () => {
  it("names every element the table shows", () => {
    expect(ELEMENT_NAMES).toHaveLength(TABLE_MAX_Z + 1);
    expect(ELEMENT_NAMES[1]).toBe("Hydrogen");
    expect(ELEMENT_NAMES[26]).toBe("Iron");
    expect(ELEMENT_NAMES[92]).toBe("Uranium");
  });

  it("sorts elements into their families", () => {
    const f = (z: number) => elementFamily(z);
    expect([f(1), f(6), f(34)]).toEqual(["nonmetal", "nonmetal", "nonmetal"]);
    expect([f(3), f(55)]).toEqual(["alkali", "alkali"]);
    expect([f(4), f(88)]).toEqual(["alkaline-earth", "alkaline-earth"]);
    expect([f(14), f(52)]).toEqual(["metalloid", "metalloid"]);
    expect([f(9), f(85)]).toEqual(["halogen", "halogen"]);
    expect([f(2), f(86)]).toEqual(["noble-gas", "noble-gas"]);
    expect([f(13), f(82)]).toEqual(["post-transition", "post-transition"]);
    expect([f(26), f(79), f(104)]).toEqual(["transition", "transition", "transition"]);
    expect([f(57), f(71)]).toEqual(["lanthanide", "lanthanide"]);
    expect([f(89), f(103)]).toEqual(["actinide", "actinide"]);
    for (let z = 1; z <= TABLE_MAX_Z; z++) expect(FAMILIES[f(z)].label).toBeTruthy();
  });
});
