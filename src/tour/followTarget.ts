/**
 * Keep a driver.js callout on the control it describes (#964).
 *
 * driver.js 1.4 places a step's popover once, and again only on a window
 * `resize` or `scroll`. That goes wrong in three ways:
 *
 * - It picks the arrow's position by a rule of its own that ignores the
 *   step's `align`: a popover beside a target whose top plus the popover's
 *   height reaches the bottom of the window gets its arrow at the popover's
 *   far end, even though the popover itself is centred on the target. The
 *   Tutorial button at the foot of the pipeline panel's rail is such a
 *   target: its arrow pointed some 60 px below the button.
 * - A target that moves or resizes without either event is left behind: a
 *   JupyterLab sidebar opening or a splitter drag (the window keeps its
 *   size), a scroll inside a panel (`scroll` does not bubble to `window`), or
 *   the viewer still settling when the tour auto-starts.
 * - A step whose target is not on screen (the pipeline panel's rail while
 *   the panel is collapsed) is drawn in the middle of the page, while its text
 *   talks about a highlighted button.
 *
 * `followActiveElement` watches the highlighted element once per animation
 * frame while a tour runs: when it moves, driver.js places the popover again,
 * and whenever the arrow does not point at the target it is moved along the
 * popover's edge until it does. `presentSteps` drops the steps whose target is
 * not on screen when the tour starts.
 */
import type { DriveStep, Driver } from "driver.js";

/** A stretch of one screen axis, in CSS pixels. */
export interface Span {
  start: number;
  end: number;
}

/**
 * How far the arrow keeps from the popover's corners (its rounded corners
 * have a 10 px radius).
 */
export const ARROW_INSET = 14;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Where on the popover's edge the arrow's centre belongs so it points at the
 * target, or `null` when it already does. All three arguments lie on the axis
 * the arrow can slide along (y for a popover beside its target, x for one
 * above or below it).
 *
 * An arrow already pointing anywhere inside the target is left alone; one that
 * is not moves to the target's centre, kept `inset` away from the popover's
 * ends. When the popover's edge does not reach the target at all, the arrow
 * goes to the end nearest it.
 */
export function arrowCorrection(
  arrowCenter: number,
  popover: Span,
  target: Span,
  inset = ARROW_INSET,
): number | null {
  const edgeStart = popover.start + inset;
  const edgeEnd = popover.end - inset;
  if (edgeStart > edgeEnd) return null; // too short to place an arrow on
  const lo = Math.max(target.start, edgeStart);
  const hi = Math.min(target.end, edgeEnd);
  if (lo <= hi && arrowCenter >= lo && arrowCenter <= hi) return null;
  const centre = (target.start + target.end) / 2;
  const want = lo <= hi ? clamp(centre, lo, hi) : clamp(centre, edgeStart, edgeEnd);
  return Math.abs(want - arrowCenter) < 0.5 ? null : want;
}

/** The side class driver.js gives the arrow (`driver-popover-arrow-side-left` → `"left"`). */
export function arrowSide(arrow: Element): "left" | "right" | "top" | "bottom" | null {
  for (const side of ["left", "right", "top", "bottom"] as const) {
    if (arrow.classList.contains(`driver-popover-arrow-side-${side}`)) return side;
  }
  return null;
}

/**
 * Point the shown popover's arrow at `target` (the highlighted element's
 * rectangle), moving it along the popover's edge if it points elsewhere.
 * Returns whether the arrow was moved.
 */
export function alignArrow(popover: HTMLElement, arrow: HTMLElement, target: DOMRect): boolean {
  const side = arrowSide(arrow);
  if (!side || getComputedStyle(arrow).display === "none") return false;
  const p = popover.getBoundingClientRect();
  const a = arrow.getBoundingClientRect();
  if (side === "left" || side === "right") {
    const want = arrowCorrection(
      a.top + a.height / 2,
      { start: p.top, end: p.bottom },
      { start: target.top, end: target.bottom },
    );
    if (want === null) return false;
    arrow.style.top = `${want - p.top - popover.clientTop - a.height / 2}px`;
    arrow.style.bottom = "auto";
    arrow.style.marginTop = "0";
  } else {
    const want = arrowCorrection(
      a.left + a.width / 2,
      { start: p.left, end: p.right },
      { start: target.left, end: target.right },
    );
    if (want === null) return false;
    arrow.style.left = `${want - p.left - popover.clientLeft - a.width / 2}px`;
    arrow.style.right = "auto";
    arrow.style.marginLeft = "0";
  }
  return true;
}

/** The id driver.js gives the stand-in element of a step without a target. */
const DUMMY_ELEMENT_ID = "driver-dummy-element";

type FollowedDriver = Pick<Driver, "isActive" | "getActiveElement" | "refresh">;

/**
 * Keep the running tour's callout on its target until the returned function
 * is called (see the module comment). `doc`, `raf` and `caf` are injectable
 * for tests.
 */
export function followActiveElement(
  tour: FollowedDriver,
  doc: Document = document,
  raf: (cb: FrameRequestCallback) => number = (cb) => window.requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => window.cancelAnimationFrame(id),
): () => void {
  let frame = 0;
  let lastElement: Element | undefined;
  let lastBox = "";
  const tick = () => {
    frame = raf(tick);
    if (!tour.isActive()) return;
    const element = tour.getActiveElement();
    if (!element || element.id === DUMMY_ELEMENT_ID) {
      lastElement = element;
      lastBox = "";
      return;
    }
    const rect = element.getBoundingClientRect();
    const box = [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(",");
    // driver.js places the new step itself; only a step whose target has
    // moved since the last frame needs placing again.
    if (element === lastElement && lastBox !== "" && box !== lastBox) tour.refresh();
    lastElement = element;
    lastBox = box;
    const popover = doc.querySelector<HTMLElement>(".driver-popover");
    const arrow = popover?.querySelector<HTMLElement>(".driver-popover-arrow");
    if (popover && arrow) alignArrow(popover, arrow, rect);
  };
  frame = raf(tick);
  return () => caf(frame);
}

/** Whether `el` is on the page with a size (a collapsed panel's rail is not). */
function onScreen(el: Element | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * The steps whose target is on screen, plus every step without one (those
 * are drawn in the middle of the page by design).
 */
export function presentSteps(steps: DriveStep[], doc: Document = document): DriveStep[] {
  return steps.filter(
    (step) => typeof step.element !== "string" || onScreen(doc.querySelector(step.element)),
  );
}
