/**
 * Spectrum parser entry point.
 *
 * JCAMP-DX decoding (AFFN / SQZ / DIF / DUP) lives in `megane-core`, so this is
 * the thin WASM facade — the same shape as `parsers/structure.ts`, but yielding
 * a `SpectrumData` rather than a `Snapshot`, since a spectrum has no
 * coordinates and never reaches the 3D renderer.
 */

import type { SpectrumData } from "../pipeline/types";

/** File-dialog filter for the Load Spectrum node. */
export const SPECTRUM_ACCEPT = ".jdx,.jcamp,.dx";

/** Drag-drop guard for the Load Spectrum node. */
export const SPECTRUM_EXTS = [".jdx", ".jcamp", ".dx"];

/** True when `name` is a file the Load Spectrum node will attempt to open. */
export function isSpectrumFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SPECTRUM_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * True when `text` looks like JCAMP-DX rather than an OpenDX grid.
 *
 * `.dx` is claimed by both. OpenDX opens with `object … class gridpositions`,
 * JCAMP-DX with `##TITLE=` / `##JCAMP-DX=`. The Load Volumetric node performs
 * the mirror-image check (`isOpenDx` in `executors/parseDx.ts`), so a `.dx`
 * dropped on either node gets an accurate answer.
 */
export function isJcampDx(text: string): boolean {
  const head = text.slice(0, 4096);
  if (/^\s*object\b[^\n]*\bclass\s+gridpositions\b/im.test(head)) return false;
  return /^\s*##\s*(TITLE|JCAMP\s*-?\s*DX)\s*=/im.test(head);
}

interface WasmSpectrumResult {
  title: string;
  data_type: string;
  x_units: string;
  y_units: string;
  n_points: number;
  warnings: string;
  x(): Float64Array;
  y(): Float64Array;
}

interface SpectrumWasmModule {
  default: (url?: string) => Promise<unknown>;
  parse_jcampdx: (text: string) => WasmSpectrumResult;
}

let modulePromise: Promise<SpectrumWasmModule> | null = null;

async function ensureWasm(): Promise<SpectrumWasmModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasm = (await import("../../crates/megane-wasm/pkg")) as unknown as SpectrumWasmModule;
      const url = (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__ as string | undefined;
      await wasm.default(url);
      return wasm;
    })();
  }
  return modulePromise;
}

/**
 * Decode a spectrum file into `SpectrumData`.
 * Rejects with a descriptive `Error` on malformed or misidentified input.
 */
export async function parseSpectrum(text: string): Promise<SpectrumData> {
  if (!isJcampDx(text)) {
    throw new Error(
      "This file is not a JCAMP-DX spectrum. If it is an OpenDX volumetric " +
        "grid — both formats use .dx — load it with the Load Volumetric node instead.",
    );
  }
  const wasm = await ensureWasm();
  const result = wasm.parse_jcampdx(text);
  // Surface non-fatal parser warnings (e.g. skipped compound-file blocks).
  if (result.warnings) {
    for (const w of result.warnings.split("\n")) {
      console.warn(`[megane parser] ${w}`);
    }
  }
  return {
    type: "spectrum",
    title: result.title,
    dataType: result.data_type,
    xUnits: result.x_units,
    yUnits: result.y_units,
    x: result.x(),
    y: result.y(),
  };
}
