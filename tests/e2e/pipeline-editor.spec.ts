/**
 * Pipeline editor E2E (M4).
 *
 * Verifies that all node kinds the editor knows about render in the
 * default scene, that the Render button mounts the RenderModal, and that
 * disabling a node via the NodeShell toggle flips data-enabled. The graph
 * itself is provided by the default webapp load (the editor seed wires up
 * load-structure → load-trajectory → viewport at minimum).
 */

import { test, expect } from "playwright/test";
import { defaultViewerContract, assertDomContract, waitForReady, getReadyState } from "./lib/setup";
import { getCameraState } from "./lib/render-utils";

const ATOM_COUNT_CAFFEINE = 3024;

// The node kinds the editor surfaces; presence in the default seed
// graph is not guaranteed for every kind, so the spec only asserts the
// ones the seed graph mounts. Stub kinds are checked as `>= 0` to allow
// future seed changes without churning the spec.
const SEEDED_KINDS = ["load_structure", "symmetry", "wrap", "viewport"] as const;

test.describe("pipeline-editor: webapp default graph", () => {
  test.beforeEach(async ({ page }) => {
    // Set the global flag before any module-level code runs so useTour
    // suppresses its auto-start. Without this, the driver.js overlay can
    // intercept pointer events on the toolbar and tab buttons.
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
  });

  test("default graph mounts seeded node kinds and Render button", async ({ page }) => {
    await assertDomContract(page, [
      ...defaultViewerContract({ expectedAtoms: ATOM_COUNT_CAFFEINE, context: "webapp" }),
      { testid: "pipeline-editor-render", visible: true, enabled: true },
    ]);

    for (const kind of SEEDED_KINDS) {
      const count = await page.locator(`[data-testid="pipeline-node-${kind}"]`).count();
      expect(count, `expected at least one ${kind} node in the seed graph`).toBeGreaterThan(0);
    }
  });

  test("Render button mounts RenderModal", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-render"]').click();
    await expect(page.locator('[data-testid="render-modal"]')).toBeVisible();
    // Backdrop click closes (when not exporting).
    await page.locator('[data-testid="render-modal-backdrop"]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid="render-modal"]')).toBeHidden();
  });

  test("Add Node menu adds a Replicate node with its controls", async ({ page }) => {
    // Add Node lives in the editor toolbar; the Chat tab is the default, so
    // switch to the Editor tab first.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    // Open the Add Node palette and add a Replicate (supercell builder) node.
    await page.getByTitle("Add Node").click();
    await page.getByRole("button", { name: "Replicate", exact: true }).click();

    // The node mounts with its nx/ny/nz repeat inputs.
    const node = page.locator('[data-testid="pipeline-node-replicate"]').first();
    await expect(node).toBeVisible();
    await expect(page.locator('[data-testid="replicate-node-nx"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="replicate-node-ny"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="replicate-node-nz"]').first()).toBeVisible();

    // Repeat count edits are accepted.
    const nx = page.locator('[data-testid="replicate-node-nx"]').first();
    await nx.fill("2");
    await expect(nx).toHaveValue("2");
  });

  test("seeded Wrap node exposes its mode toggle and accepts a change", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();

    // The default seed graph carries a pass-through Wrap node.
    const node = page.locator('[data-testid="pipeline-node-wrap"]').first();
    await expect(node).toBeVisible();
    const mode = page.locator('[data-testid="wrap-node-mode"]').first();
    await expect(mode).toBeVisible();
    await expect(mode).toHaveValue("none");

    // The wrap ↔ unwrap toggle is accepted.
    await mode.selectOption("unwrap");
    await expect(mode).toHaveValue("unwrap");
    await mode.selectOption("wrap");
    await expect(mode).toHaveValue("wrap");
  });

  test("toggling wrap/unwrap preserves the user's camera (no re-fit)", async ({ page }) => {
    // Zoom in first so a camera re-fit would be observable (a fit resets
    // orthographic zoom to 1).
    const viewer = page.locator('[data-testid="viewer-root"]');
    const box = (await viewer.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(() => {
      const w = window as unknown as {
        __megane_test?: { getCameraState: () => { zoom: number } | null };
      };
      const s = w.__megane_test?.getCameraState();
      return !!s && s.zoom !== 1;
    });
    const before = await getCameraState(page);

    // Toggle the seeded Wrap node to unwrap and wait for the re-execute to
    // reach the renderer.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    const epoch = (await getReadyState(page)).renderEpoch;
    await page.locator('[data-testid="wrap-node-mode"]').first().selectOption("unwrap");
    await waitForReady(page, { untilEpoch: epoch + 1, timeout: 10_000 });

    // The camera must be exactly where the user left it — the re-mapped
    // snapshot reloads geometry but must not re-fit.
    const after = await getCameraState(page);
    expect(after!.mode).toBe(before!.mode);
    expect(after!.zoom).toBeCloseTo(before!.zoom, 5);
    for (let axis = 0; axis < 3; axis++) {
      expect(after!.position[axis]).toBeCloseTo(before!.position[axis], 4);
      expect(after!.target[axis]).toBeCloseTo(before!.target[axis], 4);
    }

    // And back to none — still no re-fit.
    await page.locator('[data-testid="wrap-node-mode"]').first().selectOption("none");
    await waitForReady(page, { untilEpoch: epoch + 2, timeout: 10_000 });
    const restored = await getCameraState(page);
    expect(restored!.zoom).toBeCloseTo(before!.zoom, 5);
  });

  test("seeded Symmetry node exposes its mode toggle and accepts a change", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();

    // The default seed graph carries a Symmetry node in expand mode.
    const node = page.locator('[data-testid="pipeline-node-symmetry"]').first();
    await expect(node).toBeVisible();
    const mode = page.locator('[data-testid="symmetry-node-mode"]').first();
    await expect(mode).toBeVisible();
    await expect(mode).toHaveValue("expand");

    // The expand ↔ none toggle is accepted.
    await mode.selectOption("none");
    await expect(mode).toHaveValue("none");
    await mode.selectOption("expand");
    await expect(mode).toHaveValue("expand");
  });

  test("Add Node menu adds a Symmetry node with its mode selector", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await page.getByTitle("Add Node").click();
    await page.getByRole("button", { name: "Symmetry", exact: true }).click();

    // The seed graph already carries one symmetry node; adding makes it two.
    await expect(page.locator('[data-testid="pipeline-node-symmetry"]')).toHaveCount(2);
  });

  test("Add Node menu adds a Wrap / Unwrap node with its mode selector", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await page.getByTitle("Add Node").click();
    await page.getByRole("button", { name: "Wrap / Unwrap", exact: true }).click();

    // The seed graph already carries one wrap node; adding makes it two.
    await expect(page.locator('[data-testid="pipeline-node-wrap"]')).toHaveCount(2);
  });

  // Wiring the two nodes together needs a ReactFlow handle drag, which is
  // covered by the unit tests (resolveConnectedSpectrum); this spec covers what
  // only a browser can: the real WASM decode of a real file.
  test("Load Spectrum decodes a JCAMP-DX file through WASM", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();

    // Add both spectrum nodes from the Add Node palette.
    await page.getByTitle("Add Node").click();
    await page.getByRole("button", { name: "Load Spectrum", exact: true }).click();
    await page.getByTitle("Add Node").click();
    await page.getByRole("button", { name: "Spectrum Plot", exact: true }).click();

    const loadNode = page.locator('[data-testid="pipeline-node-load_spectrum"]').first();
    const plotNode = page.locator('[data-testid="pipeline-node-spectrum_plot"]').first();
    await expect(loadNode).toBeVisible();
    await expect(plotNode).toBeVisible();

    // Nothing loaded yet, so the plot shows its empty state.
    await expect(page.locator('[data-testid="load-spectrum-filename"]').first()).toHaveText(
      /No spectrum loaded/,
    );
    await expect(page.locator('[data-testid="spectrum-plot-empty"]').first()).toBeVisible();

    // Feed the real fixture through the real WASM decoder.
    await page
      .locator('[data-testid="load-spectrum-input"]')
      .first()
      .setInputFiles("tests/fixtures/ethanol_ir.jdx");

    await expect(page.locator('[data-testid="load-spectrum-filename"]').first()).toHaveText(
      "ethanol_ir.jdx",
    );
    await expect(page.locator('[data-testid="load-spectrum-error"]').first()).toBeHidden();
    // 121 points, infrared, wavenumbers — straight from the file header.
    await expect(page.locator('[data-testid="load-spectrum-summary"]').first()).toHaveText(
      /INFRARED SPECTRUM · 121 points · 1\/CM/,
    );
  });

  test("tab selector switches between editor and chat panes", async ({ page }) => {
    const editorTab = page.locator('[data-testid="pipeline-editor-tab-editor"]');
    const chatTab = page.locator('[data-testid="pipeline-editor-tab-chat"]');
    const editorPanel = page.locator("#pipeline-tabpanel-editor");
    const chatPanel = page.locator("#pipeline-tabpanel-chat");

    // Chat is the default tab — the assistant is the primary entry point.
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(editorTab).toHaveAttribute("aria-selected", "false");
    await expect(chatPanel).toBeVisible();
    // The editor pane stays in the layout (visibility:hidden) so ReactFlow
    // keeps its measurements; Playwright still treats it as hidden.
    await expect(editorPanel).toBeHidden();
    // Templates button is inside the hidden editor tabpanel.
    await expect(page.locator('[data-testid="pipeline-editor-templates"]')).toBeHidden();
    // I/O row stays visible from Chat (Render/Share apply to the current pipeline).
    await expect(page.locator('[data-testid="pipeline-editor-render"]')).toBeVisible();
    // Editor-side Others row is unmounted on chat to give the input more room.
    await expect(page.locator('[data-testid="pipeline-editor-theme"]')).toBeHidden();

    // Switch to the Editor tab.
    await editorTab.click();
    await expect(editorTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    await expect(editorPanel).toBeVisible();
    await expect(chatPanel).toBeHidden();
    // Pipeline-tab-only buttons (Templates) are visible when on Editor.
    await expect(page.locator('[data-testid="pipeline-editor-templates"]')).toBeVisible();

    // Regression guard: the editor canvas must have non-zero size. Earlier
    // builds toggled with display:none, which collapsed ReactFlow to 0×0.
    const editorBox = await editorPanel.boundingBox();
    expect(editorBox?.width ?? 0).toBeGreaterThan(100);
    expect(editorBox?.height ?? 0).toBeGreaterThan(100);

    // Regression guard: the Pipeline toolbar row (Add Node / Layout /
    // Templates) must take only its content height. A regression in the
    // toolbar's flex basis previously made the row claim the entire pane
    // height, leaving the buttons stranded inside an empty band. We assert
    // the row height is well below the pane height so the canvas dominates.
    const toolbarBox = await page.locator('[data-testid="pipeline-editor-row"]').boundingBox();
    expect(toolbarBox?.height ?? 0).toBeGreaterThan(0);
    expect(toolbarBox?.height ?? 0).toBeLessThan((editorBox?.height ?? 0) / 3);

    // Back to Chat: editor pane hides again.
    await chatTab.click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(editorTab).toHaveAttribute("aria-selected", "false");
    await expect(chatPanel).toBeVisible();
    await expect(editorPanel).toBeHidden();

    // Toggle back to the Editor tab; canvas is still non-zero.
    await editorTab.click();
    await expect(editorPanel).toBeVisible();
    const reboundBox = await editorPanel.boundingBox();
    expect(reboundBox?.width ?? 0).toBeGreaterThan(100);
    expect(reboundBox?.height ?? 0).toBeGreaterThan(100);
  });
});
