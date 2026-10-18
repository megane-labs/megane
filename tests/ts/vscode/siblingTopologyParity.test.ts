import { describe, it, expect } from "vitest";
import { siblingTopologyName as extensionHostCopy } from "../../../vscode-megane/src/extension";
import { siblingTopologyName } from "../../../src/hosts/classifyStandaloneFile";

// The VS Code extension host is compiled on its own (`rootDir: ./src`) and
// cannot import the shared `src/` tree, so it keeps a local copy of the
// sibling-`.top` lookup. This pins that copy to the shared helper the
// JupyterLab DocWidget uses, so the two hosts cannot drift apart.
describe("siblingTopologyName parity (VS Code extension host ↔ shared)", () => {
  it.each([
    "water.gro",
    "Box.GRO",
    "conf.run1.gro",
    "sims/water.gro",
    ".gro",
    "1crn.pdb",
    "water.top",
    "gro",
    "",
    "water.gro.bak",
    "POSCAR",
  ])("agrees on %j", (name) => {
    expect(extensionHostCopy(name)).toBe(siblingTopologyName(name));
  });
});
