/**
 * Web Worker that embeds a sketch in 3D with RDKit (the `megane-rdkit`
 * WebAssembly build: ETKDG conformer generation followed by an MMFF94s / UFF
 * minimisation). The call is synchronous inside RDKit and takes tens to
 * hundreds of milliseconds for a drug-sized molecule, so it runs off the main
 * thread; the client is `embed.ts`.
 *
 * The module is loaded on the first request. The `.wasm` URL is resolved on
 * the main thread (Vite knows where the asset lands there) and passed in with
 * every request so the worker never has to guess its own base path.
 */

import { loadRDKit, type RDKit } from "megane-rdkit";
import type { EmbedRequest, EmbedResponse } from "./embedMessages";

interface WorkerSelf {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const ctx = self as unknown as WorkerSelf;

let rdkit: Promise<RDKit> | null = null;

/** The RDKit module, loaded once per worker; a failed load is retried on the next request. */
export function getRDKit(wasmUrl: string): Promise<RDKit> {
  if (!rdkit) {
    rdkit = loadRDKit({ locateFile: () => wasmUrl }).catch((err: unknown) => {
      rdkit = null;
      throw err;
    });
  }
  return rdkit;
}

/** Handle one request; exported so the message loop can be unit-tested without a worker. */
export async function handleRequest(req: EmbedRequest): Promise<EmbedResponse> {
  try {
    const module = await getRDKit(req.wasmUrl);
    const result = module.embed(req.molfile, req.options);
    return { id: req.id, ok: true, result, version: module.version() };
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ctx.onmessage = async (e: MessageEvent<EmbedRequest>) => {
  ctx.postMessage(await handleRequest(e.data));
};
