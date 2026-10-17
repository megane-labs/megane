/**
 * Pipeline editor E2E (M4).
 *
 * Verifies that all node kinds the editor knows about render in the
 * default scene, that the Render button mounts the RenderModal, and that
 * disabling a node via the NodeShell toggle flips data-enabled. The graph
 * itself is provided by the default webapp load (the editor seed wires up
 * load-structure → load-trajectory → viewport at minimum).
 */

import { test, expect, type Page } from "playwright/test";
import { defaultViewerContract, assertDomContract, waitForReady, getReadyState } from "./lib/setup";
import { getCameraState } from "./lib/render-utils";

const ATOM_COUNT_CAFFEINE = 3024;

/**
 * Find an editor edge whose point at `fraction` of its length is not hidden
 * under a node card, move the pointer there and return the edge id. The ×
 * button appears at the midpoint on hover, so selecting by click should use
 * a point away from 0.5.
 */
async function hoverExposedEdge(page: Page, fraction: number): Promise<string> {
  const target = await page.evaluate((f) => {
    for (const g of document.querySelectorAll<SVGGElement>(".react-flow__edge")) {
      const path = g.querySelector<SVGPathElement>(".react-flow__edge-path");
      const ctm = path?.getScreenCTM();
      if (!path || !ctm) continue;
      const p = path.getPointAtLength(path.getTotalLength() * f).matrixTransform(ctm);
      if (g.contains(document.elementFromPoint(p.x, p.y))) {
        return { id: g.getAttribute("data-id") ?? "", x: p.x, y: p.y };
      }
    }
    return null;
  }, fraction);
  expect(target, "expected an edge that is not covered by a node").not.toBeNull();
  await page.mouse.move(target!.x, target!.y);
  return target!.id;
}

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
    // The Chat tab is the default, so switch to the Editor tab first.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    // Open the Add Node palette and add a Replicate (supercell builder) node.
    await page.getByTitle("Add Node").click();
    await page.getByRole("menuitem", { name: "Replicate", exact: true }).click();

    // The seed graph already has a Replicate node; the new one is selected,
    // so its nx/ny/nz repeat inputs are the ones shown in the properties pane.
    await expect(page.locator('[data-testid="pipeline-node-replicate"]')).toHaveCount(2);
    await expect(
      page.locator('[data-testid="pipeline-node-replicate"][data-selected="true"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="replicate-node-nx"]:visible')).toHaveCount(1);
    await expect(page.locator('[data-testid="replicate-node-ny"]:visible')).toHaveCount(1);
    await expect(page.locator('[data-testid="replicate-node-nz"]:visible')).toHaveCount(1);

    // Repeat count edits are accepted.
    const nx = page.locator('[data-testid="replicate-node-nx"]:visible');
    await nx.fill("2");
    await expect(nx).toHaveValue("2");
  });

  test("hovering an edge reveals a × button that deletes it", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    const edges = page.locator(".react-flow__edge");
    await expect(edges.first()).toBeVisible();
    const before = await edges.count();

    const edgeId = await hoverExposedEdge(page, 0.5);
    const del = page.locator(`[data-testid="pipeline-edge-delete-${edgeId}"]`);
    await expect(del).toBeVisible();
    await del.click();

    await expect(edges).toHaveCount(before - 1);
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"]`)).toHaveCount(0);
  });

  test("the Delete key removes a selected edge", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    const edges = page.locator(".react-flow__edge");
    await expect(edges.first()).toBeVisible();
    const before = await edges.count();

    await hoverExposedEdge(page, 0.25);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
    await page.keyboard.press("Delete");
    await expect(edges).toHaveCount(before - 1);
  });

  test("seeded Wrap node exposes its mode toggle and accepts a change", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();

    // The default seed graph carries a pass-through Wrap node; selecting its
    // card opens its form in the properties pane.
    const node = page.locator('[data-testid="pipeline-node-wrap"]').first();
    await expect(node).toBeVisible();
    await node.click();
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
    await page.locator('[data-testid="pipeline-node-wrap"]').first().click();
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
    await node.click();
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
    await page.getByRole("menuitem", { name: "Symmetry", exact: true }).click();

    // The seed graph already carries one symmetry node; adding makes it two.
    await expect(page.locator('[data-testid="pipeline-node-symmetry"]')).toHaveCount(2);
  });

  test("Add Node menu adds a Wrap / Unwrap node with its mode selector", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await page.getByTitle("Add Node").click();
    await page.getByRole("menuitem", { name: "Wrap / Unwrap", exact: true }).click();

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
    await page.getByRole("menuitem", { name: "Load Spectrum", exact: true }).click();
    await page.getByTitle("Add Node").click();
    await page.getByRole("menuitem", { name: "Spectrum Plot", exact: true }).click();

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

  test("Add Node menu adds an Isosurface node with color-by-volume controls", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await page.getByTitle("Add Node").click();
    await page.getByRole("menuitem", { name: "Isosurface", exact: true }).click();

    const node = page.locator('[data-testid="pipeline-node-isosurface"]').first();
    await expect(node).toBeVisible();

    // Solid coloring is the default: the color picker is shown, the
    // volume-coloring controls are not.
    const colorMode = page.locator('[data-testid="isosurface-color-mode"]').first();
    await expect(colorMode).toBeVisible();
    await expect(colorMode).toHaveValue("solid");
    await expect(page.locator('[data-testid="isosurface-color"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="isosurface-colormap"]')).toHaveCount(0);

    // Switching to volume coloring swaps in the colormap + range controls.
    await colorMode.selectOption("volume");
    await expect(colorMode).toHaveValue("volume");
    const colormap = page.locator('[data-testid="isosurface-colormap"]').first();
    await expect(colormap).toBeVisible();
    await expect(colormap).toHaveValue("rwb");
    await expect(page.locator('[data-testid="isosurface-range-min"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="isosurface-range-max"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="isosurface-color"]')).toHaveCount(0);

    // Colormap changes and explicit range edits are accepted.
    await colormap.selectOption("rainbow");
    await expect(colormap).toHaveValue("rainbow");
    await page.locator('[data-testid="isosurface-range-min"]').first().fill("-0.05");
    await page.locator('[data-testid="isosurface-range-max"]').first().fill("0.05");
    await expect(page.locator('[data-testid="isosurface-range-min"]').first()).toHaveValue("-0.05");
    await expect(page.locator('[data-testid="isosurface-range-max"]').first()).toHaveValue("0.05");

    // And back to solid: the color picker returns.
    await colorMode.selectOption("solid");
    await expect(page.locator('[data-testid="isosurface-color"]').first()).toBeVisible();
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
    // The rail sits beside the tab panels, so its buttons stay on every tab.
    const rail = page.locator('[data-testid="pipeline-rail"]');
    await expect(rail).toBeVisible();
    await expect(page.locator('[data-testid="pipeline-editor-templates"]')).toBeVisible();
    await expect(page.locator('[data-testid="pipeline-editor-render"]')).toBeVisible();
    await expect(page.locator('[data-testid="pipeline-editor-theme"]')).toBeVisible();

    // Switch to the Editor tab.
    await editorTab.click();
    await expect(editorTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    await expect(editorPanel).toBeVisible();
    await expect(chatPanel).toBeHidden();

    // Regression guard: the editor canvas must have non-zero size. Earlier
    // builds toggled with display:none, which collapsed ReactFlow to 0×0.
    const editorBox = await editorPanel.boundingBox();
    expect(editorBox?.width ?? 0).toBeGreaterThan(100);
    expect(editorBox?.height ?? 0).toBeGreaterThan(100);

    // The rail is a narrow column down the panel's left edge, beside (not
    // above) the editor pane, so the graph keeps the panel's full height.
    const railBox = await rail.boundingBox();
    expect(railBox?.width ?? 0).toBeGreaterThan(0);
    expect(railBox?.width ?? 0).toBeLessThan(60);
    expect((railBox?.x ?? 0) + (railBox?.width ?? 0)).toBeLessThanOrEqual((editorBox?.x ?? 0) + 1);

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

// Layout and properties pane. These assert geometry on the DOM rather than
// pixels: the point is that nodes do not overlap, the graph fits the panel,
// and the properties pane edits the selected node.
test.describe("pipeline-editor: layout and properties pane", () => {
  type Box = { id: string; x: number; y: number; w: number; h: number };

  async function nodeBoxes(page: import("playwright/test").Page): Promise<Box[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".react-flow__node")].map((n) => {
        const r = n.getBoundingClientRect();
        return { id: n.dataset.id ?? "", x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
  }

  function overlapping(boxes: Box[]): string[] {
    const hits: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          hits.push(`${a.id}/${b.id}`);
        }
      }
    }
    return hits;
  }

  async function settle(page: import("playwright/test").Page): Promise<void> {
    // Layout runs after xyflow measures the nodes, then fitView animates;
    // wait until two consecutive reads of the node boxes agree.
    let prev = "";
    await expect
      .poll(async () => {
        const cur = JSON.stringify(await nodeBoxes(page));
        const stable = cur === prev;
        prev = cur;
        return stable;
      })
      .toBe(true);
  }

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await page.locator('[data-testid="pipeline-editor-templates"]').click();
    await page.locator('[data-testid="pipeline-template-protein"]').click();
    await settle(page);
  });

  test("a template is laid out without overlaps and fitted into the panel", async ({ page }) => {
    const boxes = await nodeBoxes(page);
    expect(boxes.length).toBeGreaterThan(5);
    expect(overlapping(boxes)).toEqual([]);

    const flow = (await page.locator(".react-flow").first().boundingBox())!;
    for (const b of boxes) {
      expect(b.x, b.id).toBeGreaterThanOrEqual(flow.x - 1);
      expect(b.y, b.id).toBeGreaterThanOrEqual(flow.y - 1);
      expect(b.x + b.w, b.id).toBeLessThanOrEqual(flow.x + flow.width + 1);
      expect(b.y + b.h, b.id).toBeLessThanOrEqual(flow.y + flow.height + 1);
    }
  });

  test("selecting a card opens its form in the properties pane", async ({ page }) => {
    await expect(page.locator('[data-testid="pipeline-properties-empty"]')).toBeVisible();

    const card = page.locator(
      '[data-node-id="protein-filter"][data-testid="pipeline-node-filter"]',
    );
    await expect(card.locator('[data-testid="pipeline-node-summary"]')).toHaveText(
      'resname != "HOH"',
    );
    await card.click();
    await expect(card).toHaveAttribute("data-selected", "true");

    const header = page.locator('[data-testid="pipeline-properties-header"]');
    await expect(header).toContainText("Filter");
    const form = page.locator(
      '[data-testid="pipeline-properties-form"][data-node-id="protein-filter"]',
    );
    await expect(form).toBeVisible();
    // Only the selected node's form is shown.
    await expect(
      page.locator('[data-testid="pipeline-properties-form"][data-node-id="water-filter"]'),
    ).toBeHidden();

    // Editing in the pane updates the card's summary.
    const query = form.locator("input").first();
    await query.fill('resname == "ALA"');
    await query.press("Enter");
    await expect(card.locator('[data-testid="pipeline-node-summary"]')).toHaveText(
      'resname == "ALA"',
    );
  });

  test("the enable switch in the pane disables the node's card", async ({ page }) => {
    const card = page.locator('[data-node-id="water-modify"]').first();
    await card.click();
    await page.locator('[data-testid="pipeline-properties-header"] [role="switch"]').click();
    await expect(card).toHaveAttribute("data-enabled", "false");
    await expect(card).toContainText("Off");
  });
});
