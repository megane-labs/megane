/**
 * Build panel E2E (webapp).
 *
 * Verifies the Build panel (a peer of the Pipeline panel, stacked under it
 * with its own collapsed stub): picking tools, editing through the 3D
 * view's click handlers, and — crucially — that every edit lands as an op in
 * the `load_structure` node's edit list (the graph gains no node; the loader
 * shows a count) and changes the rendered atom count. Also covers edit mode
 * (an open panel shows the loader's structure, not the pipeline's view) and
 * "New empty cell", the one scene with a cell and no atoms. Asserts DOM and
 * store state rather than pixels to stay robust against font/GL drift.
 */

import { test, expect } from "playwright/test";
import { waitForReady } from "./lib/setup";
import { alignCamera, getCameraState } from "./lib/render-utils";

const ATOM_COUNT_CAFFEINE = 3024;

interface LoaderInfo {
  id: string;
  edits: { op: string }[];
  nodeTypes: string[];
}

/** The primary loader's edit list plus the node types in the graph. */
async function loaderInfo(page: import("playwright/test").Page): Promise<LoaderInfo | null> {
  return await page.evaluate(() => {
    const store = (
      window as unknown as {
        __megane_test_pipeline_store?: {
          getState: () => {
            nodes: { id: string; type?: string; data: { params: Record<string, unknown> } }[];
          };
        };
      }
    ).__megane_test_pipeline_store;
    const nodes = store?.getState().nodes ?? [];
    const node = nodes.find((n) => n.type === "load_structure");
    if (!node) return null;
    return {
      id: node.id,
      edits: (node.data.params.edits as { op: string }[] | undefined) ?? [],
      nodeTypes: nodes.map((n) => n.type ?? ""),
    };
  });
}

/** Expand the Build panel from its own collapsed stub under the Pipeline panel. */
async function openBuild(page: import("playwright/test").Page) {
  const panel = page.locator('[data-testid="panel-build"]');
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await page.locator('[data-testid="panel-build-toggle"]').click();
  await expect(panel).toHaveAttribute("data-collapsed", "false");
  await expect(page.locator('[data-testid="build-panel"]')).toBeVisible();
}

/**
 * Drive the Build panel's own pick handler, exactly what the Viewport calls on
 * a click. Going through the store (rather than a synthetic canvas click)
 * keeps the spec independent of where a given atom lands on screen.
 */
async function pickAtom(page: import("playwright/test").Page, atomIndex: number | null) {
  await page.evaluate((idx) => {
    const store = (
      window as unknown as {
        __megane_test_build_store?: {
          getState: () => { handlers: { pick: (i: unknown) => void } | null };
        };
      }
    ).__megane_test_build_store;
    const handlers = store?.getState().handlers;
    if (!handlers) throw new Error("Build handlers not installed; is the Build tab open?");
    handlers.pick({ atomIndex: idx, world: idx === null ? [0, 0, 0] : null, shiftKey: false });
  }, atomIndex);
}

test.describe("build: webapp", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
  });

  test("edits from the Build panel land on the loader and change the rendered structure", async ({
    page,
  }) => {
    // Several pipeline re-executions on a 3k-atom structure plus a tab switch
    // that mounts the node graph: comfortably past the default budget.
    test.slow();
    await openBuild(page);
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("0 edits");

    const viewer = page.locator('[data-testid="megane-viewer"]').first();
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));

    // Delete tool: one click removes one atom.
    await page.locator('[data-testid="build-tool-delete"]').click();
    await pickAtom(page, 0);
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("1 edit");
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE - 1));

    // Add tool with nitrogen: attaches a bonded atom.
    await page.locator('[data-testid="build-tool-add"]').click();
    await page.locator('[data-testid="build-element-N"]').click();
    await pickAtom(page, 0);
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("2 edits");
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));

    let info = await loaderInfo(page);
    expect(info).not.toBeNull();
    expect(info!.edits.map((o) => o.op)).toEqual(["delete_atoms", "add_atom"]);
    // The history is input data, not a node: the graph gained nothing.
    expect(info!.nodeTypes).not.toContain("edit");

    // Undo pops the last op and Redo restores it.
    await page.locator('[data-testid="build-undo"]').click();
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("1 edit");
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE - 1));
    await page.locator('[data-testid="build-redo"]').click();
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("2 edits");

    // Reflection: the Editor tab's loader node shows the count — and the Build
    // panel stays open beside it, since it is its own panel rather than a tab.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await expect(page.locator('[data-testid="load-structure-edits"]').first()).toHaveText(
      /2 edits/,
    );
    await expect(page.locator('[data-testid="build-panel"]')).toBeVisible();

    // Clearing the history (the same store action the node's Clear button
    // calls; driven through the store because React Flow's canvas overlays
    // intercept synthetic clicks on node bodies) restores the atoms.
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: { getState: () => { clearEditOps: () => void } };
        }
      ).__megane_test_pipeline_store!;
      store.getState().clearEditOps();
    });
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));
    await expect(page.locator('[data-testid="load-structure-edits"]')).toHaveCount(0);
    info = await loaderInfo(page);
    expect(info!.edits).toHaveLength(0);

    // Collapsing the panel from its header leaves the stub and normal view mode.
    await page.locator('[data-testid="panel-build-toggle"]').click();
    await expect(page.locator('[data-testid="panel-build"]')).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator('[data-testid="build-panel"]')).toHaveCount(0);
  });

  test("editing keeps the camera where the user left it", async ({ page }) => {
    await openBuild(page);
    // Leave the standard orientation so a re-fit would be visible as a change.
    await alignCamera(page, "+a");
    const before = await getCameraState(page);
    expect(before).not.toBeNull();

    const viewer = page.locator('[data-testid="megane-viewer"]').first();
    await page.locator('[data-testid="build-tool-delete"]').click();
    await pickAtom(page, 0);
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE - 1));
    await page.locator('[data-testid="build-tool-add"]').click();
    await pickAtom(page, 0);
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));
    await page.locator('[data-testid="build-undo"]').click();
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE - 1));

    const after = await getCameraState(page);
    expect(after!.position).toEqual(before!.position);
    expect(after!.target).toEqual(before!.target);
    expect(after!.zoom).toBe(before!.zoom);
    expect(after!.up).toEqual(before!.up);
  });

  test("edit mode shows the loader's structure while the pipeline replicates it", async ({
    page,
  }) => {
    test.slow();
    const viewer = page.locator('[data-testid="megane-viewer"]').first();
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));

    // Make the pipeline's view differ from the loaded structure: 2×1×1.
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: {
            getState: () => {
              nodes: { id: string; type?: string }[];
              updateNodeParams: (id: string, p: Record<string, unknown>) => void;
            };
          };
        }
      ).__megane_test_pipeline_store!;
      const rep = store.getState().nodes.find((n) => n.type === "replicate");
      if (!rep) throw new Error("the default pipeline has no replicate node");
      store.getState().updateNodeParams(rep.id, { nx: 2, ny: 1, nz: 1 });
    });
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE * 2));

    // Opening Build switches to edit mode: the loader's own atoms, no pause.
    await openBuild(page);
    await expect(page.locator('[data-testid="build-edit-mode-note"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-provenance-warning"]')).toHaveCount(0);
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));

    // Edits apply to the loaded structure…
    await page.locator('[data-testid="build-tool-delete"]').click();
    await pickAtom(page, 0);
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE - 1));
    expect((await loaderInfo(page))!.edits).toEqual([{ op: "delete_atoms", atoms: [0] }]);

    // …and closing the panel re-applies the pipeline to the edited structure.
    await page.locator('[data-testid="panel-build-toggle"]').click();
    await expect(page.locator('[data-testid="panel-build"]')).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(viewer).toHaveAttribute("data-atom-count", String((ATOM_COUNT_CAFFEINE - 1) * 2));
  });

  test("New empty cell starts from nothing, keeps the pipeline, and takes the first atom", async ({
    page,
  }) => {
    const before = (await loaderInfo(page))!.nodeTypes;
    await openBuild(page);
    await page.locator('[data-testid="build-new-cell-edge"]').fill("12");
    await page.locator('[data-testid="build-new-cell"]').click();

    // An atom-less structure with a cell is a valid scene: the viewer reports
    // zero atoms, the loader holds the cell, and the graph is untouched.
    const viewer = page.locator('[data-testid="megane-viewer"]').first();
    await expect(viewer).toHaveAttribute("data-atom-count", "0");
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const store = (
            window as unknown as {
              __megane_test_pipeline_store?: {
                getState: () => {
                  nodes: { id: string; type?: string; data: { params: { fileName?: string } } }[];
                  nodeSnapshots: Record<
                    string,
                    { snapshot: { nAtoms: number; box: Float32Array | null } }
                  >;
                };
              };
            }
          ).__megane_test_pipeline_store!;
          const state = store.getState();
          const loader = state.nodes.find((n) => n.type === "load_structure");
          const snap = loader ? state.nodeSnapshots[loader.id]?.snapshot : undefined;
          return {
            fileName: loader?.data.params.fileName ?? null,
            nAtoms: snap?.nAtoms ?? null,
            edge: snap?.box ? snap.box[0] : null,
          };
        }),
      )
      .toEqual({ fileName: "untitled", nAtoms: 0, edge: 12 });
    const info = (await loaderInfo(page))!;
    expect(info.edits).toEqual([]);
    expect(info.nodeTypes).toEqual(before);
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("0 edits");

    // A real click on empty space: with no atoms the camera framed the cell,
    // so the pivot sits at its centre and the atom lands there.
    await page.locator('[data-testid="build-tool-add"]').click();
    const box = (await viewer.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2);
    await expect(viewer).toHaveAttribute("data-atom-count", "1");
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("1 edit");
    const first = (await loaderInfo(page))!.edits[0] as {
      op: string;
      position: [number, number, number];
    };
    expect(first.op).toBe("add_atom");
    // Somewhere inside the 12 Å cell, at the pivot's depth.
    for (const c of first.position) {
      expect(c).toBeGreaterThan(-1);
      expect(c).toBeLessThan(13);
    }

    // A second atom attached to the first: bonded at covalent length, and the
    // bond is drawn (the loader's own bonds are what edit mode shows).
    await pickAtom(page, 0);
    await expect(viewer).toHaveAttribute("data-atom-count", "2");
    const bonds = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: {
            getState: () => { viewportState: { bonds: { nBonds: number }[] } };
          };
        }
      ).__megane_test_pipeline_store!;
      return store.getState().viewportState.bonds.reduce((n, b) => n + b.nBonds, 0);
    });
    expect(bonds).toBe(1);
  });

  test("the edit history survives a pipeline export / import round trip", async ({ page }) => {
    await openBuild(page);
    await page.locator('[data-testid="build-tool-delete"]').click();
    await pickAtom(page, 5);
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("1 edit");

    const ops = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: {
            getState: () => {
              serialize: () => { nodes: { type: string; edits?: unknown[] }[] };
              deserialize: (p: unknown) => void;
            };
          };
        }
      ).__megane_test_pipeline_store!;
      const json = store.getState().serialize();
      const serialized = json.nodes.find((n) => n.type === "load_structure")!;
      store.getState().deserialize(json);
      const after = store
        .getState()
        .serialize()
        .nodes.find((n) => n.type === "load_structure")!;
      return { before: serialized.edits, after: after.edits };
    });
    expect(ops.before).toEqual([{ op: "delete_atoms", atoms: [5] }]);
    expect(ops.after).toEqual(ops.before);
  });
});
