/**
 * 3D embedding of a sketch with RDKit, for the Builder's molecule library.
 *
 * A Ketcher sketch is a flat drawing; what the user wants in the document is
 * a 3D molecule. `megane-rdkit` (RDKit compiled to WebAssembly) turns the
 * molfile into a conformer with ETKDG, adds the hydrogens the valences call
 * for, and relaxes it with MMFF94s (UFF when MMFF has no parameters for the
 * molecule). The work runs in a Web Worker (`embed.worker.ts`) because the
 * call is synchronous inside RDKit; the worker is created on the first
 * request and reused, and torn down when it crashes or a call times out so
 * the next request starts clean.
 *
 * Nothing here is a parser: the result is a V2000 mol block that goes back
 * through the same MOL parser every host uses (see `sketch.ts`).
 */

import EmbedWorker from "./embed.worker?worker";
import wasmAssetUrl from "megane-rdkit/dist/megane-rdkit.wasm?url";
import type { EmbedOptions, EmbedResult } from "megane-rdkit";
import type { EmbedRequest, EmbedResponse } from "./embedMessages";

/** How long one embedding may take before the worker is presumed stuck. */
export const EMBED_TIMEOUT_MS = 120_000;

export interface EmbedSketchOptions {
  /** Add the hydrogens the valences call for before embedding (default true). */
  addHydrogens?: boolean;
  /** Force field for the final minimisation (default MMFF94s, falling back to UFF). */
  forceField?: EmbedOptions["forceField"];
  /** ETKDG random seed; the same sketch embeds to the same geometry by default. */
  randomSeed?: number;
}

export interface EmbeddedSketch {
  /** The embedded molecule as a V2000 mol block, hydrogens explicit. */
  molblock: string;
  /** Final force-field energy in kcal/mol, null when no force field ran. */
  energy: number | null;
  converged: boolean;
  forceField: EmbedResult["forceField"];
  /** Non-fatal notes from RDKit (the UFF fallback, a random-coordinates retry, …). */
  warnings: string[];
  /** RDKit release the worker loaded, e.g. "2026.03.6". */
  rdkitVersion: string;
}

interface Pending {
  resolve: (r: EmbeddedSketch) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

/** Resolve the `.wasm` URL against the page so a worker served from a blob: URL can still fetch it. */
function resolveWasmUrl(): string {
  try {
    return new URL(wasmAssetUrl, globalThis.location?.href).href;
  } catch {
    return wasmAssetUrl;
  }
}

/** Reject every in-flight request and drop the worker; the next call creates a fresh one. */
function tearDown(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new EmbedWorker();
  w.onmessage = (e: MessageEvent<EmbedResponse>) => {
    const res = e.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) {
      const r = res.result;
      p.resolve({
        molblock: r.molblocks[0],
        energy: r.energies[0] ?? null,
        converged: r.converged[0] ?? false,
        forceField: r.forceField,
        warnings: r.warnings,
        rdkitVersion: res.version,
      });
    } else {
      p.reject(new Error(res.error));
    }
  };
  w.onerror = () => tearDown("The RDKit worker crashed.");
  worker = w;
  return w;
}

/** True when this environment can run the embedding at all (a Web Worker is needed). */
export function canEmbed(): boolean {
  return typeof Worker !== "undefined";
}

/**
 * Embed `molfile` (a mol block or SMILES) in 3D. Rejects with RDKit's own
 * message when the molecule cannot be parsed or embedded, and with a
 * descriptive error when the worker is unavailable, crashes or times out.
 */
export function embedSketch(
  molfile: string,
  options: EmbedSketchOptions = {},
): Promise<EmbeddedSketch> {
  if (!canEmbed()) {
    return Promise.reject(new Error("3D embedding needs Web Workers, which this host lacks."));
  }
  const rdkitOptions: EmbedOptions = {
    format: "auto",
    sanitize: true,
    addHs: options.addHydrogens ?? true,
    removeHs: false,
    numConfs: 1,
    forceField: options.forceField ?? "MMFF94s",
  };
  if (options.randomSeed !== undefined) rdkitOptions.randomSeed = options.randomSeed;
  const req: EmbedRequest = {
    id: nextId++,
    wasmUrl: resolveWasmUrl(),
    molfile,
    options: rdkitOptions,
  };
  return new Promise<EmbeddedSketch>((resolve, reject) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const timer = setTimeout(() => {
      tearDown(`RDKit did not answer within ${EMBED_TIMEOUT_MS / 1000} s.`);
    }, EMBED_TIMEOUT_MS);
    pending.set(req.id, { resolve, reject, timer });
    w.postMessage(req);
  });
}

/** Drop the worker (tests, and hosts that want to free the ~3.5 MB module). */
export function disposeEmbedWorker(): void {
  tearDown("The RDKit worker was disposed.");
}
