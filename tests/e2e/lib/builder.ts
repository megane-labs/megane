/**
 * Shared steps for megane Builder E2E specs on every host (the web app's
 * `/builder.html`, the JupyterLab tab, the Jupyter widget, the VS Code tab).
 * Each takes the scope the Builder renders in: the page, or the webview /
 * widget frame.
 */

import { expect, type Frame, type Locator, type Page } from "playwright/test";

export type Scope = Page | Frame;
/** Where the Builder's controls are: a page, a frame, or the element a widget output renders in. */
export type Root = { locator(selector: string, options?: { hasText?: string | RegExp }): Locator };

export interface BuilderState {
  fileName: string | null;
  edits: number;
  nAtoms: number | null;
  tool: string;
}

/** The Builder store, through the test-mode window hook. */
export async function builderState(scope: Scope): Promise<BuilderState> {
  return await scope.evaluate(() => {
    const store = (
      window as unknown as {
        __megane_test_builder_store?: {
          getState: () => {
            fileName: string | null;
            edits: unknown[];
            result: { snapshot: { nAtoms: number } } | null;
            tool: string;
          };
        };
      }
    ).__megane_test_builder_store;
    if (!store) throw new Error("__megane_test_builder_store not exposed; testMode off?");
    const s = store.getState();
    return {
      fileName: s.fileName,
      edits: s.edits.length,
      nAtoms: s.result?.snapshot.nAtoms ?? null,
      tool: s.tool,
    };
  });
}

/** Delete atom `index` through the Builder's own pick handler (what a click in the view calls). */
export async function deleteAtom(scope: Scope, index: number): Promise<void> {
  await scope.evaluate((idx) => {
    const store = (
      window as unknown as {
        __megane_test_builder_store: {
          getState: () => {
            setTool: (t: string) => void;
            handlers: { pick: (i: unknown) => void } | null;
          };
        };
      }
    ).__megane_test_builder_store;
    store.getState().setTool("delete");
    const handlers = store.getState().handlers;
    if (!handlers) throw new Error("Builder handlers not installed");
    handlers.pick({ atomIndex: idx, world: null, shiftKey: false });
  }, index);
}

/** Structure › Clean up geometry on the whole structure, with the real RDKit worker (menus: see `saveAs`). */
export async function cleanUpWithRDKit(scope: Root, menus: Root = scope): Promise<void> {
  await scope.locator('[data-testid="builder-structure"]').click();
  await menus.locator('[data-testid="builder-structure-cleanup"]').click();
  await expect(scope.locator('[data-testid="builder-notice"]')).toContainText(
    "Cleaned up 1 molecule",
    { timeout: 90_000 },
  );
}

/**
 * Open the sketch dialog from the Place tool's gallery. The dialog is portaled
 * to the document body, so `modal` is where to find it when `scope` is narrower.
 */
export async function openSketch(scope: Root, modal: Root = scope): Promise<void> {
  await scope.locator('[data-testid="builder-tool-place"]').click();
  await expect(scope.locator('[data-testid="builder-library"]')).toBeVisible();
  await scope.locator('[data-testid="builder-library-sketch"]').click();
  await expect(modal.locator('[data-testid="sketch-modal"]')).toBeVisible();
}

/** Wait until the real Ketcher build has started inside the sketch dialog. */
export async function waitForKetcher(scope: Scope): Promise<void> {
  await scope.waitForFunction(
    () => !!(window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher,
    null,
    { timeout: 90_000 },
  );
}

/** Add `molfile` (a MOL block or SMILES) to the library through the sketch dialog's Paste MOL field. */
export async function addPastedMolecule(
  scope: Root,
  molfile: string,
  name: string,
  modal: Root = scope,
): Promise<void> {
  await modal.locator('[data-testid="sketch-paste-toggle"]').click();
  await modal.locator('[data-testid="sketch-molfile"]').fill(molfile);
  await modal.locator('[data-testid="sketch-name"]').fill(name);
  await modal.locator('[data-testid="sketch-add"]').click();
  await expect(modal.locator('[data-testid="sketch-modal"]')).toHaveCount(0, { timeout: 90_000 });
  await expect(
    scope.locator('[data-testid="builder-library-item-name"]', { hasText: name }),
  ).toHaveCount(1);
}

/** Pick a format from the File menu's Save entries (menus are portaled to the body: `menus`). */
export async function saveAs(scope: Root, format: string, menus: Root = scope): Promise<void> {
  await scope.locator('[data-testid="builder-file"]').click();
  await menus.locator(`[data-testid="builder-save-${format}"]`).click();
}

/**
 * Flow mode: switch to it, add a molecule-from-SMILES block, check the graph
 * editor drew it with React Flow's styles (the stylesheet the Builder inlines
 * for every host bundle: a block is absolutely positioned), run it — RDKit
 * embeds the SMILES in the page — and open the result in Manual mode. Menus
 * are portaled to the document body: `menus`.
 */
export async function buildSmilesInFlow(
  scope: Root,
  smiles: string,
  menus: Root = scope,
): Promise<void> {
  await scope.locator('[data-testid="builder-mode-flow"]').click();
  await expect(scope.locator('[data-testid="builder-flow-panel"]')).toBeVisible({
    timeout: 30_000,
  });
  await scope.locator('[data-testid="builder-flow-add"]').click();
  await menus.locator('[data-testid="builder-flow-add-smiles"]').click();
  await scope.locator('[data-testid="builder-flow-molecule-smiles"]').fill(smiles);
  await expect(scope.locator(".react-flow__node").first()).toHaveCSS("position", "absolute");
  await scope.locator('[data-testid="builder-flow-run"]').click();
  await expect(scope.locator('[data-testid="builder-flow-node-molecule"]')).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 90_000 },
  );
  await scope.locator('[data-testid="builder-flow-open-manual"]').click();
  await expect(scope.locator('[data-testid="megane-builder"]')).toHaveAttribute(
    "data-mode",
    "manual",
  );
}
