/**
 * Hover-tooltip placement check shared by the host specs.
 *
 * The tooltip is `position: fixed` and fed the cursor's `clientX/Y`. Hosts
 * that put a CSS containing block above the viewer (Lumino's
 * `contain: strict` panels and notebook cells' `contain: layout` in
 * JupyterLab, transformed webview containers, …) used to turn that into an
 * offset from the panel, so the tooltip appeared far from the pointer. This
 * hovers atoms until the tooltip shows and asserts it is drawn beside the
 * cursor in page coordinates.
 */

import { expect, type Frame, type Page } from "playwright/test";
import { getProjectedAtoms } from "./render-utils";

/** Max distance (px) between the cursor and the tooltip's nearest corner. */
const MAX_GAP_PX = 40;

/**
 * Hover a front-facing atom that no overlay covers and assert the tooltip is
 * drawn beside the cursor. `scope` is the frame the viewer lives in (the
 * webview frame for VSCode hosts); mouse coordinates are page coordinates.
 */
export async function expectTooltipNearCursor(
  page: Page,
  scope: Page | Frame = page,
): Promise<void> {
  const viewer = scope.locator('[data-testid="megane-viewer"]').first();
  const canvas = viewer.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box, "viewer canvas must have a bounding box").not.toBeNull();

  const atoms = (await getProjectedAtoms(scope))
    .filter((a) => a.depth > 0)
    .sort((a, b) => a.depth - b.depth);
  // Keep the atoms whose projected centre is not under a panel or toolbar.
  const reachable = await canvas.evaluate(
    (el, pts) =>
      pts.filter(([sx, sy]) => {
        const r = el.getBoundingClientRect();
        return el.ownerDocument.elementFromPoint(r.left + sx, r.top + sy) === el;
      }),
    atoms.slice(0, 200).map((a) => [a.sx, a.sy] as [number, number]),
  );
  expect(reachable.length, "no uncovered atom to hover").toBeGreaterThan(0);

  const tooltip = scope.locator('[data-testid="megane-tooltip"]');
  for (const [sx, sy] of reachable.slice(0, 20)) {
    const mx = box!.x + sx;
    const my = box!.y + sy;
    await page.mouse.move(mx, my);
    try {
      await tooltip.waitFor({ state: "visible", timeout: 1_000 });
    } catch {
      continue;
    }
    const tip = await tooltip.boundingBox();
    expect(tip, "tooltip must have a bounding box").not.toBeNull();
    const nearestX = Math.max(tip!.x, Math.min(mx, tip!.x + tip!.width));
    const nearestY = Math.max(tip!.y, Math.min(my, tip!.y + tip!.height));
    const gap = Math.hypot(nearestX - mx, nearestY - my);
    expect(
      gap,
      `tooltip at (${tip!.x.toFixed(0)}, ${tip!.y.toFixed(0)}) is ${gap.toFixed(0)}px ` +
        `from the cursor at (${mx.toFixed(0)}, ${my.toFixed(0)})`,
    ).toBeLessThanOrEqual(MAX_GAP_PX);
    return;
  }
  throw new Error("hovering the viewer's front atoms never showed the tooltip");
}
