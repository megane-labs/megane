import { describe, it, expect, beforeEach } from "vitest";
import { usePipelineStore } from "@megane/pipeline/store";
import { TabStoreCache } from "../../../jupyterlab-megane/src/tabStoreCache";

// Each JupyterLab Megane tab keeps a copy of the singleton pipeline store and
// puts it back when shown. These cover the ownership rules that decide when a
// tab may re-take its copy.

function nodeTypes(): string[] {
  return usePipelineStore
    .getState()
    .nodes.map((n) => n.type ?? "")
    .sort();
}

/** Load a "file" in `tab`: claim, reset, then mark the graph with `marker`. */
function load(tab: TabStoreCache, marker: "filter" | "modify"): void {
  tab.claim();
  usePipelineStore.getState().reset();
  usePipelineStore.getState().addNode(marker);
  tab.capture();
}

let stale: TabStoreCache[] = [];
function tab(): TabStoreCache {
  const t = new TabStoreCache();
  stale.push(t);
  return t;
}

beforeEach(() => {
  // Release tabs from earlier tests so none of them still owns the store.
  for (const t of stale) t.release();
  stale = [];
  usePipelineStore.getState().reset();
});

describe("TabStoreCache", () => {
  it("brings back the edits made in a tab after another tab was shown", () => {
    const a = tab();
    const b = tab();
    load(a, "filter");
    const aLoaded = nodeTypes();
    usePipelineStore.getState().addNode("color");
    const aEdited = nodeTypes();
    expect(aEdited).not.toEqual(aLoaded);

    a.save(); // A hidden
    load(b, "modify"); // B opened and loaded
    expect(nodeTypes()).not.toContain("color");

    b.save(); // B hidden
    a.restore(); // A shown
    expect(nodeTypes()).toEqual(aEdited);

    a.save();
    b.restore();
    expect(nodeTypes()).toContain("modify");
    expect(nodeTypes()).not.toContain("filter");
  });

  it("saves the current owner's edits when another tab loads its file", () => {
    const a = tab();
    const b = tab();
    load(a, "filter");
    usePipelineStore.getState().addNode("color");
    const aEdited = nodeTypes();
    // B opens in another dock area: A is never hidden.
    load(b, "modify");
    a.restore();
    expect(nodeTypes()).toEqual(aEdited);
  });

  it("saves the current owner's edits when another tab is shown", () => {
    const a = tab();
    const b = tab();
    load(b, "modify");
    load(a, "filter");
    usePipelineStore.getState().addNode("color");
    const aEdited = nodeTypes();
    // B is shown in a split pane while A stays visible.
    b.restore();
    expect(nodeTypes()).toContain("modify");
    a.restore();
    expect(nodeTypes()).toEqual(aEdited);
  });

  it("does not take another tab's state when hidden after losing the store", () => {
    const a = tab();
    const b = tab();
    load(a, "filter");
    const aLoaded = nodeTypes();
    load(b, "modify"); // B takes the store over while A stays visible
    a.save(); // A hidden later: the store holds B's graph, not A's
    b.save();
    a.restore();
    expect(nodeTypes()).toEqual(aLoaded);
  });

  it("keeps the edits when the owning tab is shown again", () => {
    const a = tab();
    load(a, "filter");
    usePipelineStore.getState().addNode("color");
    const aEdited = nodeTypes();
    // A non-Megane tab was in front; nothing else touched the store.
    a.restore();
    expect(nodeTypes()).toEqual(aEdited);
  });

  it("leaves the store alone when shown before its first load finished", () => {
    const a = tab();
    const b = tab();
    const c = tab();
    load(a, "filter");
    const before = usePipelineStore.getState().nodes;
    b.restore();
    expect(usePipelineStore.getState().nodes).toBe(before);
    // B never became the owner, so A's later edits are still A's to keep.
    usePipelineStore.getState().addNode("color");
    const aEdited = nodeTypes();
    load(c, "modify");
    a.restore();
    expect(nodeTypes()).toEqual(aEdited);
  });

  it("does not save a closed tab", () => {
    const a = tab();
    const b = tab();
    load(a, "filter");
    const aLoaded = nodeTypes();
    load(b, "modify");
    usePipelineStore.getState().addNode("color");
    b.release(); // B closed
    a.restore();
    expect(nodeTypes()).toEqual(aLoaded);
    // The closed tab's copy was not updated by A taking the store back.
    b.restore();
    expect(nodeTypes()).toContain("modify");
    expect(nodeTypes()).not.toContain("color");
  });
});
