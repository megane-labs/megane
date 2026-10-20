/**
 * The pieces the Builder's two floating rails (tools, operations) are made
 * of: the frosted column, its 38 px icon buttons and 20 px stroke icons, the
 * rule between groups, and the small mark in a button's corner. The viewer's
 * Pipeline panel builds its own rail from the same pieces.
 *
 * The buttons are icons only, so `RailLabels` names the one under the pointer
 * or the keyboard focus in a small label beside the rail, at once rather than
 * after the browser's tooltip delay.
 */

import { useEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ACCENT_TEXT, ACCENT_TINT } from "./styles";
import { floatingSurfaceStyle } from "../components/toolbarStyles";

export const TOOL_RAIL_WIDTH = 50;

/** The frosted column itself. */
export const railStyle: CSSProperties = {
  ...floatingSurfaceStyle,
  width: TOOL_RAIL_WIDTH,
  boxSizing: "border-box",
  padding: "6px 0",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  pointerEvents: "auto",
};

export function railButtonStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    width: 38,
    height: 38,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    background: active ? ACCENT_TINT : "transparent",
    color: active ? ACCENT_TEXT : "var(--megane-text-secondary, #64748b)",
  };
}

/** Where a button's corner mark (shortcut key, flyout ▸) sits. */
export const railCornerMarkStyle: CSSProperties = {
  position: "absolute",
  right: 3,
  bottom: 1,
};

/** A 20 px stroke icon drawn in currentColor, so the active tint carries over. */
export function RailIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** The thin rule between groups of buttons. */
export function RailDivider() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 24,
        height: 1,
        margin: "3px 0",
        background: "var(--megane-border-solid, #e2e8f0)",
      }}
    />
  );
}

/** The small ▸ in the corner that says "this opens a menu". */
export function FlyoutMark() {
  return (
    <span
      aria-hidden="true"
      style={{
        ...railCornerMarkStyle,
        fontSize: 8,
        color: "var(--megane-text-muted, #94a3b8)",
      }}
    >
      ▸
    </span>
  );
}

/** The rails whose buttons `RailLabels` names: the Builder's two, and any opting in. */
export const RAIL_LABEL_SELECTOR =
  '[data-testid="builder-tool-rail"], [data-testid="builder-operations-rail"], [data-rail-labels]';

/** The rail button an event happened on, if it is one `RailLabels` names. */
function railButtonOf(target: EventTarget | null): HTMLElement | null {
  const el = target as Element | null;
  const button = typeof el?.closest === "function" ? el.closest("button") : null;
  return button?.closest(RAIL_LABEL_SELECTOR) ? (button as HTMLElement) : null;
}

/** A rail button's name: its accessible label, else its title up to " — ". */
export function railButtonName(button: Element): string {
  const label = button.getAttribute("aria-label");
  if (label) return label;
  return (button.getAttribute("title") ?? "").split(" — ")[0].trim();
}

/**
 * The name of the rail button under the pointer or the keyboard focus, in a
 * small label to the right of the rail; gone on a click, Escape, or when the
 * button's own menu is open. Mount it once per Builder, with `scope` the
 * element holding its rails (the whole document without one).
 */
export function RailLabels({ scope }: { scope?: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState<{ text: string; left: number; top: number } | null>(null);

  useEffect(() => {
    const root: HTMLElement | Document | null = scope ? scope.current : document;
    if (!root) return;
    const show = (e: Event) => {
      const button = railButtonOf(e.target);
      if (!button) return;
      const text = railButtonName(button);
      if (!text || button.getAttribute("aria-expanded") === "true") return setShown(null);
      const r = button.getBoundingClientRect();
      setShown({ text, left: r.right + 8, top: r.top + r.height / 2 });
    };
    const leave = (e: Event) => {
      const button = railButtonOf(e.target);
      if (!button) return;
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && button.contains(to)) return;
      setShown(null);
    };
    const hide = () => setShown(null);
    const onKey = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") hide();
    };
    const listeners: [string, (e: Event) => void][] = [
      ["pointerover", show],
      ["focusin", show],
      ["pointerout", leave],
      ["focusout", leave],
      ["click", hide],
      ["keydown", onKey],
    ];
    for (const [type, fn] of listeners) root.addEventListener(type, fn, true);
    return () => {
      for (const [type, fn] of listeners) root.removeEventListener(type, fn, true);
    };
  }, [scope]);

  if (!shown) return null;
  return createPortal(
    <div
      data-testid="builder-rail-label"
      aria-hidden="true"
      style={{
        position: "fixed",
        left: shown.left,
        top: shown.top,
        transform: "translateY(-50%)",
        zIndex: 1100,
        pointerEvents: "none",
        padding: "3px 8px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: "nowrap",
        background: "var(--megane-text, #1e293b)",
        color: "var(--megane-surface-solid, #f8f9fb)",
        boxShadow: "0 2px 8px var(--megane-shadow-strong, rgba(0, 0, 0, 0.15))",
      }}
    >
      {shown.text}
    </div>,
    document.body,
  );
}
