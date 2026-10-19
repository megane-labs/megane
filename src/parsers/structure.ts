/**
 * Structure parser entry points (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF,
 * LAMMPS data, AMBER topology (.prmtop), ASE .traj).
 *
 * This module is a thin facade. The heavy file parse runs off the main thread
 * via `parseClient` (Web Worker, with a synchronous fallback); the small
 * bond/label helpers run synchronously on the main thread from `parseCore`.
 * Signatures are unchanged so callers and `openFile.ts` are untouched.
 */

export type { StructureParseResult } from "./parseCore";
export { parseStructureFile, parseStructureText } from "./parseClient";
export {
  indexStructureLazy,
  parseStructureHead,
  parseStructurePrefix,
  prewarmParseWorker,
  shouldUseLazyStructure,
  type StructureLazyHandle,
  type StructureLazyResult,
} from "./parseClient";
export type { LazyStructureKind } from "./parseCore";
export {
  inferBondsVdw,
  parseTopBonds,
  parseTopBondsWithIncludes,
  parsePsfBonds,
  parsePdbBonds,
  extractLabelsFromFile,
} from "./parseCore";
