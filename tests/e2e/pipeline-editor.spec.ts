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

  test("the assistant is docked in the default Editor tab, between graph and properties", async ({
    page,
  }) => {
    const editorTab = page.locator('[data-testid="pipeline-editor-tab-editor"]');
    const inspectorTab = page.locator('[data-testid="pipeline-editor-tab-inspector"]');
    const editorPanel = page.locator("#pipeline-tabpanel-editor");
    const inspectorPanel = page.locator("#pipeline-tabpanel-inspector");
    const chatInput = page.locator('[data-testid="pipeline-chat-input"]');

    // The Editor tab is the default, and there is no Chat tab any more.
    await expect(editorTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="pipeline-editor-tab-chat"]')).toHaveCount(0);
    await expect(editorPanel).toBeVisible();
    await expect(chatInput).toBeVisible();

    // Graph above, prompt bar, properties pane below.
    const flowBox = await editorPanel.locator(".react-flow").boundingBox();
    const chatBox = await chatInput.boundingBox();
    const propsBox = await page.locator('[data-testid="pipeline-properties"]').boundingBox();
    expect(flowBox!.y + flowBox!.height).toBeLessThanOrEqual(chatBox!.y + 1);
    expect(chatBox!.y + chatBox!.height).toBeLessThanOrEqual(propsBox!.y + 1);

    // Regression guard: the editor canvas must have non-zero size. Earlier
    // builds toggled with display:none, which collapsed ReactFlow to 0×0.
    const editorBox = await editorPanel.boundingBox();
    expect(editorBox?.width ?? 0).toBeGreaterThan(100);
    expect(editorBox?.height ?? 0).toBeGreaterThan(100);

    // The rail is a narrow column down the panel's left edge, beside (not
    // above) the editor pane, so the graph keeps the panel's full height.
    const rail = page.locator('[data-testid="pipeline-rail"]');
    const railBox = await rail.boundingBox();
    expect(railBox?.width ?? 0).toBeGreaterThan(0);
    expect(railBox?.width ?? 0).toBeLessThan(60);
    expect((railBox?.x ?? 0) + (railBox?.width ?? 0)).toBeLessThanOrEqual((editorBox?.x ?? 0) + 1);

    // The conversation opens over the bottom of the canvas.
    await page.locator('[data-testid="pipeline-chat-toggle"]').click();
    const history = page.locator('[data-testid="pipeline-chat-history"]');
    await expect(history).toBeVisible();
    const historyBox = await history.boundingBox();
    expect(historyBox!.y + historyBox!.height).toBeLessThanOrEqual(chatBox!.y + 1);

    // The Inspector tab hides the editor pane, assistant included; the editor
    // pane stays in the layout (visibility:hidden) so ReactFlow keeps its size.
    await inspectorTab.click();
    await expect(inspectorPanel).toBeVisible();
    await expect(editorPanel).toBeHidden();
    await expect(chatInput).toBeHidden();
    await editorTab.click();
    await expect(chatInput).toBeVisible();
    const reboundBox = await editorPanel.boundingBox();
    expect(reboundBox?.width ?? 0).toBeGreaterThan(100);
    expect(reboundBox?.height ?? 0).toBeGreaterThan(100);
  });

  test("the assistant edits the current graph, keeps the loaded files, and can undo", async ({
    page,
  }) => {
    // Stand in for the Anthropic API: read the pipeline the chat sent, make
    // the change a model would (replicate twice along a, and — like every
    // generated pipeline — no file names), and stream it back.
    const requests: string[] = [];
    await page.route("https://api.anthropic.com/v1/messages", async (route) => {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "POST, OPTIONS",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const body = route.request().postDataJSON() as {
        messages: { role: string; content: unknown }[];
      };
      const message = String(body.messages[body.messages.length - 1].content);
      requests.push(message);
      // A self-check repair round carries no graph; answer from the request.
      const current = /## Current pipeline[\s\S]*?```json\n([\s\S]*?)\n```/.exec(requests[0]);
      const pipeline = JSON.parse(current![1]) as {
        nodes: Record<string, unknown>[];
      };
      for (const node of pipeline.nodes) {
        if (node.type === "replicate") node.nx = 2;
        if ("fileName" in node) node.fileName = null;
      }
      const reply =
        "```json\n" + JSON.stringify(pipeline) + "\n```\nReplicates the cell twice along a.";
      const sse =
        "event: content_block_delta\n" +
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: reply } })}\n\n` +
        "event: message_delta\n" +
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`;
      await route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "text/event-stream" },
        body: sse,
      });
    });

    const loader = page.locator('[data-testid="pipeline-node-load_structure"]').first();
    const replicate = page.locator('[data-testid="pipeline-node-replicate"]').first();
    await expect(loader).toContainText("caffeine_water.pdb");
    await expect(replicate).toContainText("1 × 1 × 1");

    // This build has no free-demo proxy, so enter a key in the settings.
    await page.locator('button[title="AI Settings"]').click();
    await page
      .locator('[data-testid="pipeline-chat-settings"] input[type="password"]')
      .fill("sk-ant-test");

    // Select the Replicate node, then ask about "this".
    await replicate.click();
    const input = page.locator('[data-testid="pipeline-chat-input"]');
    await expect(input).toHaveAttribute("placeholder", /Replicate/);
    await input.fill("make this 2 along a");
    await input.press("Enter");

    await expect(page.getByText("Replicates the cell twice along a.")).toBeVisible();
    // The pipeline passes the self-check, so no repair round was needed.
    expect(requests, requests.slice(1).join("\n---\n")).toHaveLength(1);
    expect(requests[0]).toContain("## Current pipeline");
    expect(requests[0]).toMatch(/Selected in the editor: `[^`]+` \(replicate\)/);
    expect(requests[0]).toContain("make this 2 along a");

    // The graph changed in place, and it drew from the files that stayed
    // loaded: the structure replicated twice, the trajectory still attached.
    const viewer = page.locator('[data-testid="megane-viewer"]');
    await expect(replicate).toContainText("2 × 1 × 1");
    await expect(loader).toContainText("caffeine_water.pdb");
    await expect(viewer).toHaveAttribute("data-atom-count", String(2 * ATOM_COUNT_CAFFEINE));
    await expect(viewer).toHaveAttribute("data-total-frames", "100");

    // Undo puts the previous graph back.
    await page.locator('[data-testid="pipeline-chat-undo"]').click();
    await expect(page.getByText("(undone)")).toBeVisible();
    await expect(page.locator('[data-testid="pipeline-node-replicate"]').first()).toContainText(
      "1 × 1 × 1",
    );
    await expect(loader).toContainText("caffeine_water.pdb");
    await expect(viewer).toHaveAttribute("data-atom-count", String(ATOM_COUNT_CAFFEINE));
    await expect(viewer).toHaveAttribute("data-total-frames", "100");
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
      'resname != "HOH" and resname != "MK1"',
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
