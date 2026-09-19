/**
 * The Builder's molecule library: molecules kept ready to drop into the
 * document as `add_fragment` ops. Presets ship with the app; the user adds
 * their own by sketching in Ketcher, importing a file, or saving a selection.
 */

/** Atoms and bonds of one molecule, fragment-local (centroid at the origin), in Å. */
export interface MoleculeGeometry {
  /** Atomic numbers. */
  elements: number[];
  /** Flat `[x0,y0,z0, x1,y1,z1, …]`. */
  positions: number[];
  /** Intra-molecule bonds as local atom index pairs. */
  bonds: [number, number][];
  /** Bond orders parallel to `bonds` (1..4); omitted means all single. */
  bondOrders?: number[];
}

/** Where a library molecule came from. */
export type LibraryOrigin = "preset" | "sketch" | "file" | "selection";

/** A named molecule the Builder can place. */
export interface LibraryMolecule extends MoleculeGeometry {
  /** `preset:<slug>` for presets, `user:<random>` for the user's molecules. */
  id: string;
  name: string;
  /** Hill-order formula, e.g. `C2H6O`; derived from `elements` and kept for display. */
  formula: string;
  origin: LibraryOrigin;
  /** The Ketcher molfile a sketch was made from, so it can be re-opened for editing. */
  molfile?: string;
  /**
   * True when the geometry is flat (a 2D sketch): the molecule was drawn, not
   * embedded in 3D, and its coordinates were only rescaled to Å.
   */
  planar?: boolean;
}

/** A molecule about to enter the user library: everything but the id. */
export type LibraryMoleculeDraft = Omit<LibraryMolecule, "id">;
