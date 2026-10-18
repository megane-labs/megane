/**
 * The Jupyter widget of megane Builder (`megane.Builder()`): the document
 * written back to `_document`, files handed in through `_source`, Save and the
 * RDKit module going through the kernel, and one Builder per page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";

const { mountBuilder, parseStructureFile, downloadBlob, mounts } = vi.hoisted(() => {
  const mounts: { el: HTMLElement; host: unknown; disposed: boolean }[] = [];
  return {
    mounts,
    mountBuilder: vi.fn((el: HTMLElement, host: unknown) => {
      const m = { el, host, disposed: false };
      mounts.push(m);
      el.dataset.mounted = "yes";
      return {
        open: vi.fn(),
        dispose: () => {
          m.disposed = true;
        },
      };
    }),
    parseStructureFile: vi.fn(),
    downloadBlob: vi.fn(),
  };
});

vi.mock("@/builder/mount", () => ({ mountBuilder }));
vi.mock("@/parsers/structure", () => ({ parseStructureFile }));
vi.mock("@/renderer/RenderCapture", () => ({ downloadBlob }));
// The WASM writer does not load under vitest; the formats are stand-ins.
vi.mock("@/export/structureExport", () => ({
  snapshotToText: vi.fn(async (_s: unknown, format: string) => `TEXT-${format}`),
}));

import widget, {
  documentState,
  traitBytes,
  restoreDocument,
  openSource,
  kernelSave,
  rdkitWasmFromKernel,
  resetRDKitWasm,
  currentOwner,
  SYNC_DEBOUNCE_MS,
  type BuilderWidgetModel,
} from "@/builderWidget";
import { useBuilderStore } from "@/builder/store";
import type { Snapshot } from "@/types";

function water(box: Float32Array | null = null): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const parsed = (snapshot = water()) => ({
  snapshot,
  labels: null,
  frames: [],
  meta: null,
  vectorChannels: [],
  scalarChannels: [],
  warnings: [],
});

type Listener = (...args: unknown[]) => void;

/** A stand-in for the anywidget model; `reply` plays the kernel. */
class FakeModel implements BuilderWidgetModel {
  state: Record<string, unknown>;
  listeners = new Map<string, Set<Listener>>();
  sent: Record<string, unknown>[] = [];
  saves = 0;
  reply: ((msg: Record<string, unknown>) => [Record<string, unknown>, unknown[]] | null) | null =
    null;
  sendThrows = false;

  constructor(state: Record<string, unknown> = {}) {
    this.state = { _instance_id: Math.random().toString(36), height: "600px", ...state };
  }
  get(key: string) {
    return this.state[key];
  }
  set(key: string, value: unknown) {
    this.state[key] = value;
  }
  save_changes() {
    this.saves++;
  }
  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }
  off(event: string, cb?: Listener) {
    if (cb) this.listeners.get(event)?.delete(cb);
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
  }
  send(content: unknown) {
    if (this.sendThrows) throw new Error("no comm");
    const msg = content as Record<string, unknown>;
    this.sent.push(msg);
    const answer = this.reply?.(msg);
    if (answer) queueMicrotask(() => this.emit("msg:custom", ...answer));
  }
}

beforeEach(() => {
  mounts.length = 0;
  mountBuilder.mockClear();
  parseStructureFile.mockReset();
  downloadBlob.mockClear();
  useBuilderStore.getState().closeDocument();
  resetRDKitWasm();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("documentState", () => {
  it("is empty with nothing open", async () => {
    const doc = await documentState(useBuilderStore.getState());
    expect(doc).toEqual({
      name: null,
      n_atoms: 0,
      n_bonds: 0,
      n_edits: 0,
      has_cell: false,
      xyz: null,
      pdb: null,
      mol: null,
    });
  });

  it("writes every format, null for one the writer refuses", async () => {
    useBuilderStore.getState().openStructure(water(new Float32Array(9).fill(1)), null, "w.xyz");
    const write = vi.fn(async (_s: Snapshot, format: string) => {
      if (format === "mol") throw new Error("too many atoms");
      return `T-${format}`;
    });
    const doc = await documentState(useBuilderStore.getState(), write);
    expect(doc).toMatchObject({
      name: "w.xyz",
      n_atoms: 3,
      n_bonds: 2,
      has_cell: true,
      xyz: "T-xyz",
      pdb: "T-pdb",
      mol: null,
    });
  });
});

describe("traitBytes", () => {
  it("reads DataViews, ArrayBuffers and typed arrays; empty is null", () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    expect([...traitBytes(new DataView(buf, 1, 2))!]).toEqual([2, 3]);
    expect([...traitBytes(buf)!]).toEqual([1, 2, 3, 4]);
    expect([...traitBytes(new Uint8Array([9]))!]).toEqual([9]);
    expect(traitBytes(new DataView(new ArrayBuffer(0)))).toBeNull();
    expect(traitBytes(new ArrayBuffer(0))).toBeNull();
    expect(traitBytes(new Uint8Array(0))).toBeNull();
    expect(traitBytes("nope")).toBeNull();
    expect(traitBytes(null)).toBeNull();
  });
});

describe("restoreDocument / openSource", () => {
  it("prefers the document written back, as PDB, under its own name", async () => {
    parseStructureFile.mockResolvedValue(parsed());
    const model = new FakeModel({
      _document: { name: "caffeine.sdf", n_atoms: 3, pdb: "PDB", xyz: "XYZ" },
    });
    expect(await restoreDocument(model)).toBe(true);
    const file = parseStructureFile.mock.calls[0][0] as File;
    expect(file.name).toBe("document.pdb");
    expect(file.size).toBe(3);
    expect(useBuilderStore.getState().fileName).toBe("caffeine.sdf");
  });

  it("falls back to XYZ, and names an unnamed document", async () => {
    parseStructureFile.mockResolvedValue(parsed());
    const model = new FakeModel({ _document: { name: null, n_atoms: 3, pdb: null, xyz: "XYZ" } });
    expect(await restoreDocument(model)).toBe(true);
    expect((parseStructureFile.mock.calls[0][0] as File).name).toBe("document.xyz");
    expect(useBuilderStore.getState().fileName).toBe("untitled.xyz");
  });

  it("falls back to the file Python loaded when the document does not parse", async () => {
    parseStructureFile.mockRejectedValueOnce(new Error("bad")).mockResolvedValue(parsed());
    const model = new FakeModel({
      _document: { n_atoms: 3, pdb: "PDB" },
      _source: new DataView(new TextEncoder().encode("SRC").buffer),
      _source_name: "water.pdb",
    });
    expect(await restoreDocument(model)).toBe(true);
    expect(useBuilderStore.getState().fileName).toBe("water.pdb");
  });

  it("opens nothing when the model holds nothing", async () => {
    const model = new FakeModel({ _document: { n_atoms: 0 } });
    expect(await restoreDocument(model)).toBe(false);
    expect(await openSource(new FakeModel())).toBe(false);
    expect(parseStructureFile).not.toHaveBeenCalled();
  });
});

describe("kernelSave", () => {
  const file = { name: "w.xyz", text: "T", format: "xyz" as const };

  it("resolves with where the kernel wrote the file", async () => {
    const model = new FakeModel();
    model.reply = (m) => [{ type: "saved", id: m.id, path: "w-1.xyz" }, []];
    await expect(kernelSave(model, file)).resolves.toBe("Saved w-1.xyz");
    expect(model.sent[0]).toMatchObject({ type: "save", name: "w.xyz", text: "T" });
    expect(model.listeners.get("msg:custom")!.size).toBe(0);
  });

  it("ignores answers to other requests and rejects with the kernel's error", async () => {
    const model = new FakeModel();
    model.reply = (m) => {
      queueMicrotask(() => model.emit("msg:custom", { type: "saved", id: "other" }));
      queueMicrotask(() => model.emit("msg:custom", undefined));
      return [{ type: "error", id: m.id, message: "read-only" }, []];
    };
    await expect(kernelSave(model, file)).rejects.toThrow("read-only");
  });

  it("times out when the kernel does not answer", async () => {
    vi.useFakeTimers();
    const model = new FakeModel();
    const p = kernelSave(model, file, 1000).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatch(/did not answer/);
  });

  it("downloads the file when there is no kernel", async () => {
    const model = new FakeModel();
    model.sendThrows = true;
    await expect(kernelSave(model, file)).resolves.toBe("Downloaded w.xyz (no kernel to save it)");
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0][1]).toBe("w.xyz");
  });
});

describe("rdkitWasmFromKernel", () => {
  beforeEach(() => {
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(
      () => "blob:rdkit",
    );
  });

  it("turns the kernel's buffer into a blob URL, once per page", async () => {
    const model = new FakeModel();
    model.reply = (m) => [
      { type: "rdkit_wasm", id: m.id },
      [new DataView(new Uint8Array([0, 97, 115, 109]).buffer)],
    ];
    await expect(rdkitWasmFromKernel(model)).resolves.toBe("blob:rdkit");
    await expect(rdkitWasmFromKernel(model)).resolves.toBe("blob:rdkit");
    expect(model.sent).toHaveLength(1);
  });

  it("explains a failure and retries next time", async () => {
    const model = new FakeModel();
    model.reply = (m) => [{ type: "rdkit_wasm", id: m.id }, []];
    await expect(rdkitWasmFromKernel(model)).rejects.toThrow(
      "RDKit is loaded through the kernel: the kernel sent no RDKit module",
    );
    model.sendThrows = true;
    await expect(rdkitWasmFromKernel(model)).rejects.toThrow(/no comm/);
    expect(model.sent).toHaveLength(1);
  });
});

describe("render: one Builder per page", () => {
  function show(model: FakeModel) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const dispose = widget.render({ model, el }) as () => void;
    return { el, dispose };
  }
  const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

  it("mounts the Builder for the newest output and offers the older one to take it back", async () => {
    const a = new FakeModel({ height: "450px" });
    const b = new FakeModel();
    const viewA = show(a);
    await flush();
    expect(currentOwner()).toBe(a);
    expect(mounts).toHaveLength(1);
    const container = viewA.el.firstElementChild as HTMLElement;
    expect(container.style.height).toBe("450px");
    expect(mounts[0].host).toMatchObject({ tools: false, scopeShortcuts: true });

    const viewB = show(b);
    await flush();
    expect(currentOwner()).toBe(b);
    expect(mounts[0].disposed).toBe(true);
    const showHere = viewA.el.querySelector(
      '[data-testid="builder-widget-show-here"]',
    ) as HTMLButtonElement;
    expect(showHere).not.toBeNull();

    showHere.click();
    await flush();
    expect(currentOwner()).toBe(a);
    expect(mounts[1].disposed).toBe(true);
    expect(viewB.el.querySelector('[data-testid="builder-widget-elsewhere"]')).not.toBeNull();

    viewB.dispose();
    viewA.dispose();
    expect(currentOwner()).toBeNull();
    viewA.el.remove();
    viewB.el.remove();
  });

  it("two outputs of one Builder keep the document when it moves between them", async () => {
    const model = new FakeModel();
    const first = show(model);
    await flush();
    useBuilderStore.getState().openStructure(water(), null, "kept.xyz");
    const second = show(model);
    await flush();
    expect(useBuilderStore.getState().fileName).toBe("kept.xyz");
    second.dispose();
    first.dispose();
  });

  it("writes the document back after edits, and opens what Python loads", async () => {
    const model = new FakeModel();
    const view = show(model);
    await flush();

    parseStructureFile.mockResolvedValue(parsed());
    model.state._source = new DataView(new TextEncoder().encode("SRC").buffer);
    model.state._source_name = "water.pdb";
    model.emit("change:_source_seq");
    await flush();
    expect(useBuilderStore.getState().fileName).toBe("water.pdb");

    await act(async () => await new Promise((r) => setTimeout(r, SYNC_DEBOUNCE_MS + 50)));
    await flush();
    const doc = model.state._document as Record<string, unknown>;
    expect(doc.name).toBe("water.pdb");
    expect(doc.n_atoms).toBe(3);
    expect(model.saves).toBeGreaterThan(0);

    model.state.height = "";
    model.emit("change:height");
    expect((view.el.firstElementChild as HTMLElement).style.height).toBe("600px");
    view.dispose();
    view.el.remove();
  });

  it("does not write back or open files while another output has the Builder", async () => {
    const a = new FakeModel();
    const b = new FakeModel();
    const viewA = show(a);
    await flush();
    const viewB = show(b);
    await flush();
    a.emit("change:_source_seq");
    await flush();
    expect(parseStructureFile).not.toHaveBeenCalled();
    viewB.dispose();
    viewA.dispose();
  });
});
