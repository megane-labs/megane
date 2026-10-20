/**
 * The words a Flow block goes by: its title (on its card, in the pane, in the
 * status line and in error messages) and the name of its structure before it
 * has run. Plain data, no React, so the engine can name the block whose input
 * failed (`engine.ts`) as the cards do. `describe.ts` re-exports them with the
 * icons and colours.
 */

import type { LibraryMolecule } from "../library/types";
import type { BuilderToolInfo } from "../tools/contract";
import type { FlowParams, MoleculeParams } from "./types";

/**
 * What a molecule block's molecule is called: its name, else its SMILES, else
 * its library entry's name. Null when there is none of them yet.
 */
export function moleculeName(params: MoleculeParams, library: LibraryMolecule[]): string | null {
  if (params.name.trim()) return params.name.trim();
  if (params.source === "smiles") return params.smiles.trim() || null;
  return library.find((x) => x.id === params.libraryId)?.name ?? null;
}

/**
 * The block's title. A molecule block names its molecule (`Molecule: CCO`),
 * so two of them can be told apart; it is plain `Molecule` until it has one.
 */
export function blockTitle(
  params: FlowParams,
  tool: BuilderToolInfo | null,
  library: LibraryMolecule[] = [],
): string {
  switch (params.type) {
    case "molecule": {
      const name = moleculeName(params, library);
      return name ? `Molecule: ${name}` : "Molecule";
    }
    case "document":
      return "Manual structure";
    case "tool":
      return tool?.label ?? (params.label || params.tool);
    case "crystal":
      return "Bulk crystal";
    case "polymer":
      return "Polymer chain";
    case "supercell":
      return "Supercell";
    case "slab":
      return "Slab";
    case "adsorb":
      return "Place on surface";
  }
}

/**
 * The name the block's structure goes by before it has run: the molecule's
 * name, else its SMILES or library entry; the block's title otherwise.
 */
export function blockName(
  params: FlowParams,
  tool: BuilderToolInfo | null,
  library: LibraryMolecule[],
): string {
  if (params.type === "molecule") return moleculeName(params, library) ?? "Molecule";
  if (params.type === "polymer" && params.name.trim()) return params.name.trim();
  return blockTitle(params, tool, library);
}
