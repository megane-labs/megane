/**
 * anywidget entry point of megane Builder in a notebook (`megane.Builder()`).
 *
 * Bridges the Python `Builder` model to the Builder app:
 *
 * - **Python → Builder.** `Builder.load(path)` sets `_source` (the file's
 *   bytes and name) and bumps `_source_seq`; the view opens it as the document.
 * - **Builder → Python.** Every change to the document is written back,
 *   debounced, into `_document`: its name, counts, and the structure as XYZ,
 *   PDB and MOL text (null for a format the writer refuses, e.g. MOL past 999
 *   atoms). `Builder.save()` / `to_ase()` read it, so the kernel always has the
 *   structure on screen without asking the front end.
 * - **Save.** File › Save sends the file to the kernel (`{type: "save"}`),
 *   which writes it into its working directory — the notebook's folder — and
 *   answers with the path. Without a kernel the file is downloaded instead.
 * - **RDKit.** The bundle leaves RDKit's `.wasm` out (3.5 MB in every
 *   notebook); Clean up and the sketch dialog's 3D embedding ask the kernel
 *   for it (`{type: "rdkit_wasm"}`) the first time they need it.
 *
 * anywidget imports this bundle once per `Builder` object, so each object has
 * its own copy of the Builder's store and edits its own document. The outputs
 * of one object share that store, so one of them shows the Builder at a time:
 * the newest output takes it over, and the others show a *Show here* button
 * that takes it back. When the module first shows (or a page reload restores)
 * an object's output, the document is opened from its `_document` (or
 * `_source`); the edit history does not survive a reload.
 */

import { downloadBlob } from "./renderer/RenderCapture";
import { mountBuilder, type MountedBuilder } from "./builder/mount";
import { useBuilderStore, shownSnapshot, type BuilderStore } from "./builder/store";
import { openStructureFile } from "./builder/open";
import { parseStructureFile } from "./parsers/structure";
import { snapshotToText } from "./export/structureExport";
import { setRDKitWasmSource } from "./builder/library/embed";
import type { BuilderHost, BuilderSaveRequest } from "./builder/host";
import type { StructureWriteFormat } from "./parsers/parseCore";
import type { Snapshot } from "./types";

export interface BuilderWidgetModel {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  save_changes(): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off?(event: string, callback?: (...args: unknown[]) => void): void;
  send(content: unknown, callbacks?: unknown, buffers?: ArrayBuffer[]): void;
}

/** What `_document` holds; the Python side reads it as a dict. */
export interface DocumentState {
  name: string | null;
  n_atoms: number;
  n_bonds: number;
  n_edits: number;
  has_cell: boolean;
  xyz: string | null;
  pdb: string | null;
  mol: string | null;
}

/** How long Save (and the RDKit download) waits for the kernel to answer. */
export const SAVE_TIMEOUT_MS = 15_000;
/** Quiet time after an edit before `_document` is rewritten. */
export const SYNC_DEBOUNCE_MS = 250;

const FORMATS: StructureWriteFormat[] = ["xyz", "pdb", "mol"];

/** The document as `_document` carries it; null texts for formats the writer refuses. */
export async function documentState(
  state: Pick<
    BuilderStore,
    "source" | "result" | "showOriginal" | "fileName" | "sourceLabels" | "edits"
  >,
  write: typeof snapshotToText = snapshotToText,
): Promise<DocumentState> {
  const shown: Snapshot | null = shownSnapshot(state);
  const texts: Record<StructureWriteFormat, string | null> = { xyz: null, pdb: null, mol: null };
  if (shown) {
    for (const format of FORMATS) {
      try {
        texts[format] = await write(shown, format, state.sourceLabels);
      } catch {
        texts[format] = null;
      }
    }
  }
  return {
    name: state.fileName,
    n_atoms: shown?.nAtoms ?? 0,
    n_bonds: shown?.nBonds ?? 0,
    n_edits: state.edits.length,
    has_cell: !!shown?.box,
    ...texts,
  };
}

/** The bytes in a `Bytes` trait (a DataView in anywidget), or null when empty. */
export function traitBytes(value: unknown): Uint8Array | null {
  if (value instanceof DataView) {
    return value.byteLength > 0
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : null;
  }
  if (value instanceof ArrayBuffer) return value.byteLength > 0 ? new Uint8Array(value) : null;
  if (value instanceof Uint8Array) return value.byteLength > 0 ? value : null;
  return null;
}

/**
 * Open what the model holds as the document: the structure last written back
 * (`_document`, so a page reload or a hand-over keeps the edits), else the file
 * Python loaded (`_source`). Resolves to whether anything was opened.
 */
export async function restoreDocument(
  model: BuilderWidgetModel,
  api = useBuilderStore,
): Promise<boolean> {
  const doc = model.get("_document") as Partial<DocumentState> | null;
  const text = doc?.pdb ?? doc?.xyz ?? null;
  if (doc && text && (doc.n_atoms ?? 0) > 0) {
    const ext = doc.pdb ? "pdb" : "xyz";
    try {
      const parsed = await parseStructureFile(new File([text], `document.${ext}`));
      api.getState().openStructure(parsed.snapshot, parsed.labels, doc.name || `untitled.${ext}`);
      return true;
    } catch {
      // Fall through to the file Python loaded.
    }
  }
  return openSource(model, api);
}

/** Open the file Python loaded (`_source`), if any. */
export async function openSource(
  model: BuilderWidgetModel,
  api = useBuilderStore,
): Promise<boolean> {
  const bytes = traitBytes(model.get("_source"));
  const name = (model.get("_source_name") as string) || "structure.pdb";
  if (!bytes) return false;
  return openStructureFile(new File([bytes.slice()], name), api);
}

/**
 * Save through the kernel: send the file, resolve with the notice once the
 * kernel says where it wrote it. Without a kernel (a saved notebook opened
 * read-only) `send` throws and the file is downloaded instead.
 */
export async function kernelSave(
  model: BuilderWidgetModel,
  file: BuilderSaveRequest,
  timeoutMs = SAVE_TIMEOUT_MS,
): Promise<string> {
  let sent = true;
  try {
    const { msg } = await ask(
      model,
      { type: "save", name: file.name, text: file.text },
      timeoutMs,
      () => (sent = false),
    );
    return `Saved ${String(msg.path ?? file.name)}`;
  } catch (err) {
    if (sent) throw err;
    downloadBlob(new Blob([file.text], { type: "text/plain" }), file.name);
    return `Downloaded ${file.name} (no kernel to save it)`;
  }
}

/**
 * Ask the kernel for something and wait for the answer with the same id:
 * `{type: "saved" | "rdkit_wasm"}` resolves, `{type: "error"}` rejects.
 */
function ask(
  model: BuilderWidgetModel,
  content: Record<string, unknown>,
  timeoutMs: number,
  onUnsent?: () => void,
): Promise<{ msg: Record<string, unknown>; buffers: unknown[] }> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const onMessage = (...args: unknown[]) => {
      const msg = args[0] as Record<string, unknown> | undefined;
      if (!msg || msg.id !== id) return;
      done();
      if (msg.type === "error") reject(new Error(String(msg.message ?? "the kernel refused")));
      else resolve({ msg, buffers: (args[1] as unknown[]) ?? [] });
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("the kernel did not answer; is it still running?"));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      model.off?.("msg:custom", onMessage);
    };
    model.on("msg:custom", onMessage);
    try {
      model.send({ ...content, id });
    } catch (err) {
      done();
      onUnsent?.();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** A Blob of the first buffer of a kernel answer (a DataView, ArrayBuffer or typed array). */
function bufferBlob(buffer: unknown, type: string): Blob | null {
  const bytes = traitBytes(buffer);
  return bytes ? new Blob([bytes.slice()], { type }) : null;
}

let rdkitUrl: Promise<string> | null = null;

/**
 * The RDKit `.wasm` as a blob: URL, fetched from the kernel once per page. A
 * failed fetch is retried on the next request.
 */
export function rdkitWasmFromKernel(
  model: BuilderWidgetModel,
  timeoutMs = 60_000,
): Promise<string> {
  if (!rdkitUrl) {
    rdkitUrl = ask(model, { type: "rdkit_wasm" }, timeoutMs)
      .then(({ buffers }) => {
        const blob = bufferBlob(buffers[0], "application/wasm");
        if (!blob) throw new Error("the kernel sent no RDKit module");
        return URL.createObjectURL(blob);
      })
      .catch((err: unknown) => {
        rdkitUrl = null;
        throw new Error(
          `RDKit is loaded through the kernel: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
  return rdkitUrl;
}

/** Forget the fetched RDKit module (tests). */
export function resetRDKitWasm(): void {
  rdkitUrl = null;
}

// ── One output of a Builder at a time ──

interface View {
  model: BuilderWidgetModel;
  /** Take the Builder into this view. */
  claim(): void;
  /** Hand it to another view: unmount and show the placeholder. */
  release(): void;
}

let owner: View | null = null;

/** The view showing the Builder now (tests). */
export function currentOwner(): BuilderWidgetModel | null {
  return owner?.model ?? null;
}

function modelId(model: BuilderWidgetModel): unknown {
  return model.get("_instance_id") ?? model;
}

/**
 * Make `view` the output showing the Builder. The first output (and, should
 * anywidget ever share one module between objects, another object's output)
 * opens its model's document; another output of the same object keeps it.
 */
export async function takeOver(view: View, api = useBuilderStore): Promise<void> {
  const previous = owner;
  if (previous === view) return;
  owner = view;
  previous?.release();
  const sameModel = previous && modelId(previous.model) === modelId(view.model);
  if (!sameModel) {
    api.getState().closeDocument();
    await restoreDocument(view.model, api);
    // Another output took the Builder while the document was being opened.
    if (owner !== view) return;
  }
  view.claim();
}

/** Forget `view` if it owns the Builder (its output was cleared). */
export function releaseOwner(view: View): void {
  if (owner === view) owner = null;
}

function render({ model, el }: { model: BuilderWidgetModel; el: HTMLElement }) {
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = (model.get("height") as string) || "600px";
  container.style.position = "relative";
  container.style.background = "var(--megane-bg, #ffffff)";
  container.style.borderRadius = "8px";
  container.style.overflow = "hidden";
  el.appendChild(container);

  const host: BuilderHost = {
    save: (file) => kernelSave(model, file),
    tools: false,
    scopeShortcuts: true,
  };

  let mounted: MountedBuilder | null = null;
  let placeholder: HTMLElement | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  const sync = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void documentState(useBuilderStore.getState()).then((doc) => {
        if (disposed || owner !== view) return;
        model.set("_document", doc);
        try {
          model.save_changes();
        } catch {
          // No kernel to tell.
        }
      });
    }, SYNC_DEBOUNCE_MS);
  };

  const showPlaceholder = () => {
    placeholder = document.createElement("div");
    placeholder.dataset.testid = "builder-widget-elsewhere";
    placeholder.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:10px;font:13px system-ui,sans-serif;" +
      "color:var(--megane-text-secondary,#64748b)";
    const text = document.createElement("div");
    text.textContent = "megane Builder is open in another output on this page.";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.testid = "builder-widget-show-here";
    button.textContent = "Show here";
    button.onclick = () => void takeOver(view);
    placeholder.append(text, button);
    container.appendChild(placeholder);
  };

  const view: View = {
    model,
    claim: () => {
      if (disposed) return;
      placeholder?.remove();
      placeholder = null;
      if (!mounted) {
        const target = document.createElement("div");
        target.style.cssText = "position:absolute;inset:0";
        container.appendChild(target);
        mounted = mountBuilder(target, host);
      }
      unsubscribe?.();
      // Write the document back whenever what Save would write changes.
      unsubscribe = useBuilderStore.subscribe((s, prev) => {
        if (
          s.source !== prev.source ||
          s.result !== prev.result ||
          s.showOriginal !== prev.showOriginal ||
          s.fileName !== prev.fileName
        ) {
          sync();
        }
      });
    },
    release: () => {
      unsubscribe?.();
      unsubscribe = null;
      mounted?.dispose();
      mounted = null;
      container.replaceChildren();
      if (!disposed) showPlaceholder();
    },
  };

  model.on("change:_source_seq", () => {
    if (owner === view) void openSource(model);
  });
  model.on("change:height", () => {
    container.style.height = (model.get("height") as string) || "600px";
  });

  // RDKit comes from the kernel of whichever Builder is on screen.
  setRDKitWasmSource(() => rdkitWasmFromKernel(owner?.model ?? model));
  void takeOver(view);

  return () => {
    disposed = true;
    if (syncTimer) clearTimeout(syncTimer);
    unsubscribe?.();
    mounted?.dispose();
    releaseOwner(view);
  };
}

export default { render };
