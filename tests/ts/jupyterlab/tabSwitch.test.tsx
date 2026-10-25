import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, within, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@megane/pipeline/store";

// Regression: every Megane tab renders from one singleton pipeline store, and
// each tab used to put back the state captured right after its file loaded.
// Edits made in a tab (a Filter node added, a structure uploaded, a template
// applied) were lost after switching to another tab and back.

const loadFile = vi.fn(async (file: File) => {
  // Mark the graph with the file it came from.
  usePipelineStore.getState().addNode(file.name.startsWith("a") ? "modify" : "color");
});
vi.mock("@megane/hooks/useMeganeLocal", () => ({
  useMeganeLocal: () => ({ loadFile, loadXtc: vi.fn() }),
}));
vi.mock("@megane/components/MeganeViewer", () => ({ MeganeViewer: vi.fn(() => null) }));
vi.mock("@megane/hooks/useTemplateData", () => ({ useTemplateData: vi.fn() }));
vi.mock("@megane/tour/useTour", () => ({ useTour: vi.fn() }));
vi.mock("@megane/components/ThemeSync", () => ({ ThemeSync: vi.fn(() => null) }));
vi.mock("@megane/styles/megane.css", () => ({}));
vi.mock("@megane/parsers/structure", () => ({ prewarmParseWorker: vi.fn() }));
vi.mock("../../../jupyterlab-megane/src/wasmLoader", () => ({ ensureWasmUrl: vi.fn() }));

import { ensureWasmUrl } from "../../../jupyterlab-megane/src/wasmLoader";
import { MeganeReactView } from "../../../jupyterlab-megane/src/MeganeDocWidget";
import { MeganePipelineReactView } from "../../../jupyterlab-megane/src/MeganePipelineDocWidget";

interface Tab {
  render(): JSX.Element;
  onAfterShow(msg: unknown): void;
  onBeforeHide(msg: unknown): void;
}

const contents = {
  get: vi.fn(async () => ({ content: "" })),
  getDownloadUrl: vi.fn(async (p: string) => `/files/${p}`),
};
const request = vi.fn(async () => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode("payload").buffer,
}));

function structureTab(path: string): Tab {
  const context = { path, ready: Promise.resolve(), model: { toString: () => "" } };
  return new MeganeReactView(context as never, contents as never, request as never) as never;
}

function pipelineTab(path: string, json: unknown): Tab {
  const text = JSON.stringify(json);
  const context = { path, ready: Promise.resolve(), model: { toString: () => text } };
  return new MeganePipelineReactView(
    context as never,
    contents as never,
    request as never,
  ) as never;
}

/**
 * Open `tab` in front of `previous` (one dock area; without one, beside the
 * tabs already open) and wait until its load settles in `state`.
 */
async function open(tab: Tab, testId: string, previous?: Tab, state = "ready"): Promise<void> {
  previous?.onBeforeHide({});
  tab.onAfterShow({});
  const { container } = render(tab.render());
  const root = () => within(container).getByTestId(testId);
  await waitFor(() => expect(root().getAttribute("data-state")).toBe(state));
}

function switchTab(from: Tab, to: Tab): void {
  from.onBeforeHide({});
  to.onAfterShow({});
}

function nodeTypes(): string[] {
  return usePipelineStore
    .getState()
    .nodes.map((n) => n.type ?? "")
    .sort();
}

beforeEach(() => {
  cleanup();
  usePipelineStore.getState().reset();
});

describe("JupyterLab tab switching", () => {
  it("keeps the edits made in a structure tab after switching away and back", async () => {
    const a = structureTab("a.pdb");
    const b = structureTab("b.pdb");
    await open(a, "megane-doc-root");
    usePipelineStore.getState().addNode("filter"); // the user's edit in A
    const aEdited = nodeTypes();
    expect(aEdited).toContain("modify");
    expect(aEdited).toContain("filter");

    await open(b, "megane-doc-root", a);
    expect(nodeTypes()).toContain("color");
    expect(nodeTypes()).not.toContain("filter");

    switchTab(b, a);
    expect(nodeTypes()).toEqual(aEdited);

    switchTab(a, b);
    expect(nodeTypes()).toContain("color");
    expect(nodeTypes()).not.toContain("filter");
  });

  it("keeps the edits made in a pipeline tab after switching away and back", async () => {
    const pipeline = {
      version: 3,
      nodes: [{ id: "viewport-1", type: "viewport", position: { x: 0, y: 0 } }],
      edges: [],
    };
    const p = pipelineTab("p.megane.json", pipeline);
    const s = structureTab("b.pdb");
    await open(p, "megane-pipeline-doc-root");
    usePipelineStore.getState().addNode("filter");
    const pEdited = nodeTypes();
    expect(pEdited).toContain("filter");

    await open(s, "megane-doc-root", p);
    expect(nodeTypes()).not.toContain("filter");

    switchTab(s, p);
    expect(nodeTypes()).toEqual(pEdited);
  });

  it("keeps the shown tab's edits when a pipeline tab beside it fails to open", async () => {
    const a = structureTab("a.pdb");
    await open(a, "megane-doc-root");
    usePipelineStore.getState().addNode("filter");
    const aEdited = nodeTypes();

    // The pipeline fails before it claimed the store, then resets the store.
    vi.mocked(ensureWasmUrl).mockRejectedValueOnce(new Error("no wasm"));
    const broken = pipelineTab("broken.megane.json", {});
    await open(broken, "megane-pipeline-doc-root", undefined, "error");
    expect(nodeTypes()).not.toContain("filter");

    switchTab(broken, a);
    expect(nodeTypes()).toEqual(aEdited);
  });
});
