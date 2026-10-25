/** Element names and families behind the periodic table. */

import { describe, it, expect } from "vitest";
import {
  ELEMENT_NAMES,
  FAMILIES,
  MAX_Z,
  RECENT_LIMIT,
  elementFamily,
  parseElement,
  useRecentElements,
} from "@/builder/elements";
import { TABLE_MAX_Z } from "@/builder/PeriodicTable";

describe("element names and families", () => {
  it("names every element the table shows", () => {
    expect(ELEMENT_NAMES).toHaveLength(TABLE_MAX_Z + 1);
    expect(ELEMENT_NAMES[1]).toBe("Hydrogen");
    expect(ELEMENT_NAMES[26]).toBe("Iron");
    expect(ELEMENT_NAMES[92]).toBe("Uranium");
    expect(ELEMENT_NAMES[93]).toBe("Neptunium");
    expect(ELEMENT_NAMES[118]).toBe("Oganesson");
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
    // The superheavy p block, by group: Nh..Lv under Tl..Po, Ts, Og.
    expect([f(112), f(113), f(116)]).toEqual(["transition", "post-transition", "post-transition"]);
    expect([f(117), f(118)]).toEqual(["halogen", "noble-gas"]);
    for (let z = 1; z <= TABLE_MAX_Z; z++) expect(FAMILIES[f(z)].label).toBeTruthy();
  });
});

describe("parseElement", () => {
  it("reads an atomic number or a symbol in any case", () => {
    expect(parseElement("26")).toBe(26);
    expect(parseElement(" 8 ")).toBe(8);
    expect(parseElement(String(MAX_Z))).toBe(118);
    expect(parseElement("Fe")).toBe(26);
    expect(parseElement("fe")).toBe(26);
    expect(parseElement("FE")).toBe(26);
    expect(parseElement("c")).toBe(6);
  });

  it("rejects anything else", () => {
    for (const bad of ["", " ", "0", "119", "-1", "2.5", "Xx", "Iron", "6a"]) {
      expect(parseElement(bad)).toBeNull();
    }
  });
});

describe("useRecentElements", () => {
  it("keeps the latest picks first, without repeats, up to the limit", () => {
    useRecentElements.setState({ recent: [] });
    const { remember } = useRecentElements.getState();
    remember(26);
    remember(29);
    remember(26);
    expect(useRecentElements.getState().recent).toEqual([26, 29]);
    for (let z = 40; z < 40 + RECENT_LIMIT; z++) remember(z);
    expect(useRecentElements.getState().recent).toHaveLength(RECENT_LIMIT);
    expect(useRecentElements.getState().recent[0]).toBe(40 + RECENT_LIMIT - 1);
    useRecentElements.setState({ recent: [] });
  });
});
