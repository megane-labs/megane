/**
 * Helpers for the guided tour's callouts (driver.js popovers), shared by the
 * webapp and JupyterLab specs (#964): where a callout sits relative to the
 * control it describes.
 */
import { expect, type Page } from "playwright/test";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Callout {
  title: string;
  popover: Box;
  arrow: Box;
  /** driver.js hides the arrow when no side has room (a target that fills the viewer gets its callout laid over it). */
  arrowShown: boolean;
  /** The highlighted control, or `null` for a step drawn mid-page. */
  target: Box | null;
  viewport: { width: number; height: number };
}

/** The callout on screen now. */
export async function readCallout(page: Page): Promise<Callout> {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const popover = document.querySelector(".driver-popover")!;
    const arrow = popover.querySelector(".driver-popover-arrow")!;
    const target = document.querySelector(".driver-active-element");
    return {
      title: popover.querySelector(".driver-popover-title")?.textContent ?? "",
      popover: box(popover),
      arrow: box(arrow),
      arrowShown:
        getComputedStyle(arrow).display !== "none" && arrow.getBoundingClientRect().width > 0,
      target: target && target.id !== "driver-dummy-element" ? box(target) : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

/** The callout's text is in view and its arrow points into its control. */
export function expectCalloutOnTarget(c: Callout): void {
  const { popover, viewport } = c;
  expect(popover.left, `${c.title}: in view`).toBeGreaterThanOrEqual(0);
  expect(popover.top, `${c.title}: in view`).toBeGreaterThanOrEqual(0);
  expect(popover.right, `${c.title}: in view`).toBeLessThanOrEqual(viewport.width);
  expect(popover.bottom, `${c.title}: in view`).toBeLessThanOrEqual(viewport.height);
  if (!c.target || !c.arrowShown) return;
  const { arrow, target } = c;
  const ax = (arrow.left + arrow.right) / 2;
  const ay = (arrow.top + arrow.bottom) / 2;
  if (ax <= target.left || ax >= target.right) {
    // Beside the control: the arrow lies within its height, in the gap.
    expect(ay, `${c.title}: arrow points at the target`).toBeGreaterThanOrEqual(target.top);
    expect(ay, `${c.title}: arrow points at the target`).toBeLessThanOrEqual(target.bottom);
    const gap = ax <= target.left ? target.left - ax : ax - target.right;
    expect(gap, `${c.title}: arrow next to the target`).toBeLessThan(30);
  } else {
    expect(ax, `${c.title}: arrow points at the target`).toBeGreaterThanOrEqual(target.left);
    expect(ax, `${c.title}: arrow points at the target`).toBeLessThanOrEqual(target.right);
  }
}

/** Whether the shown step is the tour's last. */
export async function isLastTourStep(page: Page): Promise<boolean> {
  return /done/i.test((await page.locator(".driver-popover-next-btn").textContent()) ?? "");
}

/** Go to the next step and let it settle. */
export async function nextTourStep(page: Page): Promise<void> {
  const title = await page.locator(".driver-popover-title").textContent();
  await page.locator(".driver-popover-next-btn").click();
  await expect(page.locator(".driver-popover-title")).not.toHaveText(title ?? "");
  // driver.js animates into place; the follower then corrects the arrow.
  await page.waitForTimeout(400);
}

/** Advance the running tour to the step titled `title`. */
export async function tourStepTo(page: Page, title: string): Promise<void> {
  while ((await page.locator(".driver-popover-title").textContent()) !== title) {
    expect(await isLastTourStep(page), `tour has a "${title}" step`).toBe(false);
    await nextTourStep(page);
  }
}

/** Walk the running tour to its end, checking every callout; returns the step titles. */
export async function walkTour(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    await page.waitForTimeout(400);
    const c = await readCallout(page);
    seen.push(c.title);
    expectCalloutOnTarget(c);
    if (await isLastTourStep(page)) return seen;
    await nextTourStep(page);
  }
}
