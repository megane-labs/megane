/**
 * Escape and click-outside dismissal for popovers, menus, forms and modals.
 *
 * Every mounted (enabled) caller is a layer on one page-wide stack, and a
 * single capture-phase `keydown` listener on `window` hands Escape to the
 * topmost layer only — the one enabled most recently — then marks the event
 * handled (`preventDefault` + `stopPropagation`) so it cannot also reach the
 * viewer's selection-clearing or the Builder's shortcut listeners. Before
 * this, each caller registered its own capture listener, and since
 * `stopPropagation` does not stop other listeners on the same target, one
 * Escape closed an atom menu and the form behind it together, while a menu
 * opened over a form never saw the key at all.
 *
 * Click-outside is per layer: a `pointerdown` outside all of `inside` calls
 * `onDismiss`, so one click away closes every open popover, as before.
 */

import { useEffect, useRef, type RefObject } from "react";

export interface DismissOptions {
  /**
   * Called on Escape while this is the topmost layer, and on a click outside
   * `inside`. A layer that must not close right now (an export in flight)
   * still swallows Escape; its callback just does nothing.
   */
  onDismiss: () => void;
  /** Whether the layer is open (default: true). */
  enabled?: boolean;
  /**
   * Elements a `pointerdown` inside of does not dismiss. Omit to ignore
   * outside clicks altogether (a form or a modal with its own backdrop).
   */
  inside?: readonly RefObject<HTMLElement | null>[];
}

interface Layer {
  dismiss: () => void;
}

const layers: Layer[] = [];

function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.dismiss();
}

function push(layer: Layer) {
  if (layers.length === 0) window.addEventListener("keydown", onEscape, true);
  layers.push(layer);
}

function remove(layer: Layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  if (layers.length === 0) window.removeEventListener("keydown", onEscape, true);
}

/** Number of open layers; exposed for tests. */
export function dismissLayerCount(): number {
  return layers.length;
}

export function useDismiss({ onDismiss, enabled = true, inside }: DismissOptions): void {
  // The latest callback and refs, so a re-render never re-registers the layer
  // (which would move it to the top of the stack).
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const insideRef = useRef(inside);
  insideRef.current = inside;
  const outside = inside !== undefined;

  useEffect(() => {
    if (!enabled) return;
    const layer: Layer = { dismiss: () => onDismissRef.current() };
    push(layer);
    return () => remove(layer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !outside) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (insideRef.current?.some((ref) => ref.current?.contains(target))) return;
      onDismissRef.current();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [enabled, outside]);
}
