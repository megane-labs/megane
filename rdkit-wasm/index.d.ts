/** Options for `RDKitEmbed.embed`. Every field is optional. */
export interface EmbedOptions {
  /** "auto" (default) sniffs a mol block by its counts line; else force one. */
  format?: "auto" | "smiles" | "molblock";
  /** Sanitize after parsing (default true). */
  sanitize?: boolean;
  /** Add the hydrogens the valences call for before embedding (default true). */
  addHs?: boolean;
  /** Strip hydrogens from the returned mol blocks (default false). */
  removeHs?: boolean;
  /** Number of conformers to generate (default 1). */
  numConfs?: number;
  /** Force field applied after embedding (default "MMFF94s"). MMFF falls back to UFF when it has no parameters for the molecule. */
  forceField?: "MMFF94s" | "MMFF94" | "UFF" | "none";
  /** Force-field minimisation iterations (default 500). */
  maxIters?: number;
  /** ETKDG random seed; the loader defaults to 42, -1 lets RDKit choose. */
  randomSeed?: number;
  /** Retry with random initial coordinates when embedding fails (default true). */
  retryWithRandomCoords?: boolean;
  /** Raw RDKit EmbedParameters overrides (useRandomCoords, maxIterations, pruneRmsThresh, enforceChirality, ...). */
  embedParams?: Record<string, unknown>;
}

export interface EmbedResult {
  /** One MDL mol block (V2000, explicit hydrogens unless removeHs) per conformer. */
  molblocks: string[];
  /** Final force-field energy per conformer in kcal/mol, null when no force field ran. */
  energies: (number | null)[];
  /** Whether the minimiser converged within maxIters, per conformer. */
  converged: boolean[];
  /** The force field that actually ran ("none" when skipped). */
  forceField: "MMFF94s" | "MMFF94" | "UFF" | "none";
  numAtoms: number;
  numHeavyAtoms: number;
  /** Non-fatal notes, e.g. the UFF fallback or the random-coordinates retry. */
  warnings: string[];
}

export interface RDKitEmbed {
  version(): string;
  setVerbose(verbose: boolean): void;
  /** Throws an Error when the input cannot be parsed or embedded. */
  embed(input: string, options?: EmbedOptions): EmbedResult;
}

export interface ModuleOptions {
  /** Where the Emscripten glue should fetch `rdkit-embed.wasm` from. */
  locateFile?: (path: string, prefix: string) => string;
  [key: string]: unknown;
}

export function loadRDKitEmbed(moduleOptions?: ModuleOptions): Promise<RDKitEmbed>;
