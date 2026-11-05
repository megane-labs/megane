import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isForeignLammpsPrefixFile,
  LAMMPS_SNIFF_BYTES,
  looksLikeLammpsData,
  looksLikeLammpsDump,
} from "@/hosts/lammpsPrefixFiles";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(__dirname, "../../fixtures", name)));
const bytes = (text: string) => new TextEncoder().encode(text);

describe("looksLikeLammpsData", () => {
  it.each(["water.lammps", "confined_offset.data", "data.water"])(
    "recognises the LAMMPS data fixture %s",
    (name) => {
      expect(looksLikeLammpsData(new TextDecoder().decode(fixture(name)))).toBe(true);
    },
  );

  it("needs only the atom count or the box after the comment line", () => {
    expect(looksLikeLammpsData("comment\n\n  2004   atoms  # protein\n")).toBe(true);
    expect(looksLikeLammpsData("comment\r\n-36.84 64.21 xlo xhi\r\n")).toBe(true);
  });

  it("ignores the free-form first line", () => {
    expect(looksLikeLammpsData("3 atoms\nsomething else\n")).toBe(false);
  });

  it.each([['{"atoms": 3}'], ["id,x,y,z\n1,0,0,0\n"], ["header\n3 atom types\n"], [""]])(
    "rejects %j",
    (text) => {
      expect(looksLikeLammpsData(text)).toBe(false);
    },
  );
});

describe("looksLikeLammpsDump", () => {
  it.each(["water.lammpstrj", "hetero_atoms.lammpstrj", "dump.water"])(
    "recognises the LAMMPS dump fixture %s",
    (name) => {
      expect(looksLikeLammpsDump(new TextDecoder().decode(fixture(name)))).toBe(true);
    },
  );

  it("accepts a leading blank line, a BOM, and the UNITS header", () => {
    expect(looksLikeLammpsDump("\n  ITEM: TIMESTEP\n0\n")).toBe(true);
    expect(looksLikeLammpsDump("\uFEFFITEM: UNITS\nreal\n")).toBe(true);
  });

  it("rejects anything that does not open with an ITEM: header", () => {
    expect(looksLikeLammpsDump("-- MySQL dump 10.13\n")).toBe(false);
    expect(looksLikeLammpsDump("3\nwater\nO 0 0 0\n")).toBe(false);
  });
});

describe("isForeignLammpsPrefixFile", () => {
  it("keeps prefix-named files whose content is the LAMMPS format the name claims", () => {
    expect(isForeignLammpsPrefixFile("data.water", fixture("data.water"))).toBe(false);
    expect(isForeignLammpsPrefixFile("runs/dump.water", fixture("dump.water"))).toBe(false);
  });

  it("flags prefix-named files that are something else", () => {
    expect(isForeignLammpsPrefixFile("data.json", bytes('{"a": 1}'))).toBe(true);
    expect(isForeignLammpsPrefixFile("data.csv", bytes("a,b\n1,2\n"))).toBe(true);
    expect(isForeignLammpsPrefixFile("dump.sql", bytes("CREATE TABLE t ();\n"))).toBe(true);
    expect(isForeignLammpsPrefixFile("data.h5", new Uint8Array([0x89, 0x48, 0x44, 0x46]))).toBe(
      true,
    );
  });

  it("checks the claimed format, not just any LAMMPS format", () => {
    // A dump named like a data file, and the other way round.
    expect(isForeignLammpsPrefixFile("data.run", fixture("water.lammpstrj"))).toBe(true);
    expect(isForeignLammpsPrefixFile("dump.run", fixture("water.lammps"))).toBe(true);
  });

  it("never flags a file Megane opens by its extension", () => {
    expect(isForeignLammpsPrefixFile("water.data", bytes("not lammps"))).toBe(false);
    expect(isForeignLammpsPrefixFile("dump.xyz", bytes("not lammps"))).toBe(false);
    expect(isForeignLammpsPrefixFile("1crn.pdb", bytes("not lammps"))).toBe(false);
  });

  it("looks no further than the sniff window", () => {
    const head = new Uint8Array(LAMMPS_SNIFF_BYTES + 32).fill(0x20);
    head.set(bytes("ITEM: TIMESTEP"), LAMMPS_SNIFF_BYTES + 4);
    // Only blanks within the window: there is no ITEM: line to see.
    expect(isForeignLammpsPrefixFile("dump.big", head)).toBe(true);
  });
});
