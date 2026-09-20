/**
 * Message protocol between `embed.ts` (main thread) and `embed.worker.ts`
 * (Web Worker). Kept in its own module so both sides, and their tests, share
 * one definition without importing each other.
 */

import type { EmbedOptions, EmbedResult } from "megane-rdkit";

export interface EmbedRequest {
  id: number;
  /** Where the worker should fetch `megane-rdkit.wasm` from. */
  wasmUrl: string;
  /** A SMILES or MDL mol block; RDKit sniffs which. */
  molfile: string;
  options: EmbedOptions;
}

export type EmbedResponse =
  | { id: number; ok: true; result: EmbedResult; version: string }
  | { id: number; ok: false; error: string };
