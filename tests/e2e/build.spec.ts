/**
 * Build panel E2E (webapp).
 *
 * Verifies the fourth pipeline tab: picking tools, editing through the 3D
 * view's click handlers, and — crucially — that every edit lands as an op on
 * a real `edit` pipeline node that is visible in the Editor tab and changes
 * the rendered atom count. Asserts DOM and store state rather than pixels to
 * stay robust against font/GL drift.
 */

import { test, expect } from "playwright/test";
import { waitForReady } from "./lib/setup";

const ATOM_COUNT_CAFFEINE = 3024;

interface EditNodeInfo {
  id: string;
  ops: { op: string }[];
  sourceAtomCount: number | null;
}

async function editNode(page: import("playwright/test").Page): Promise<EditNodeInfo | null> {
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
    const node = store?.getState().nodes.find((n) => n.type === "edit");
    if (!node) return null;
    return {
      id: node.id,
      ops: node.data.params.ops as { op: string }[],
      sourceAtomCount: node.data.params.sourceAtomCount as number | null,
    };
  });
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

  test("edits from the Build tab become ops on an edit node and change the rendered structure", async ({
    page,
  }) => {
    await page.locator('[data-testid="pipeline-editor-tab-build"]').click();
    const panel = page.locator('[data-testid="build-panel"]');
    await expect(panel).toBeVisible();
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

    let node = await editNode(page);
    expect(node).not.toBeNull();
    expect(node!.ops.map((o) => o.op)).toEqual(["delete_atoms", "add_atom"]);
    expect(node!.sourceAtomCount).toBe(ATOM_COUNT_CAFFEINE);

    // Undo pops the last op and Redo restores it.
    await page.locator('[data-testid="build-undo"]').click();
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("1 edit");
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE - 1));
    await page.locator('[data-testid="build-redo"]').click();
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("2 edits");

    // Reflection: the Editor tab shows the edit node.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await expect(page.locator('[data-testid="pipeline-node-edit"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="edit-node-count"]').first()).toHaveText("2 ops");

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
    await expect(page.locator('[data-testid="edit-node-count"]').first()).toHaveText("0 ops");
    node = await editNode(page);
    expect(node!.ops).toHaveLength(0);
  });

  test("the edit history survives a pipeline export / import round trip", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-build"]').click();
    await page.locator('[data-testid="build-tool-delete"]').click();
    await pickAtom(page, 5);
    await expect(page.locator('[data-testid="build-op-count"]')).toHaveText("1 edit");

    const ops = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: {
            getState: () => {
              serialize: () => { nodes: { type: string; ops?: unknown[] }[] };
              deserialize: (p: unknown) => void;
            };
          };
        }
      ).__megane_test_pipeline_store!;
      const json = store.getState().serialize();
      const serialized = json.nodes.find((n) => n.type === "edit")!;
      store.getState().deserialize(json);
      const after = store
        .getState()
        .serialize()
        .nodes.find((n) => n.type === "edit")!;
      return { before: serialized.ops, after: after.ops };
    });
    expect(ops.before).toEqual([{ op: "delete_atoms", atoms: [5] }]);
    expect(ops.after).toEqual(ops.before);
  });
});
