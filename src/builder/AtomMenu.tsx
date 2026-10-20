/**
 * The menu a right-click on an atom opens (or the Menu key / Shift + F10 for
 * the one selected atom): select its molecule or every atom of its element,
 * change it to the current element, remove one of its bonds, delete it, or
 * clean up its molecule's geometry. The edits go through `editActions.ts`,
 * so hydrogens are kept as the tools keep them. Closes on a choice, a click
 * elsewhere, or Escape; the arrow keys move between the items and Enter picks
 * one, with the first item focused on open.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { canEdit, shownSnapshot } from "./store";
import { getElementSymbol } from "../constants";
import { moleculeOf } from "./geometry";
import { runCleanup, useCleanupRunning } from "./cleanup";
import { neighboursOf } from "./hydrogens";
import { atomName } from "./placement";
import { deleteAtoms, removeBond, setElements } from "./editActions";
import { useBuilderStoreApi, useScopedBuilderStore } from "./BuilderStores";

export interface AtomMenuTarget {
  atom: number;
  /** Where the menu opens, in client (viewport) pixels. */
  x: number;
  y: number;
}

/** Gap kept between the menu and the window's edges, px. */
const EDGE_MARGIN = 8;

/**
 * Where a `width` × `height` menu opened at (`x`, `y`) goes so it stays in a
 * `viewWidth` × `viewHeight` window: it flips to the other side of the
 * pointer when it would run off the right or bottom edge, and never starts
 * above or left of the margin.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): { left: number; top: number } {
  const fit = (at: number, size: number, view: number) => {
    const pos = at + size > view - EDGE_MARGIN ? at - size : at;
    return Math.max(EDGE_MARGIN, Math.min(pos, view - EDGE_MARGIN - size));
  };
  return { left: fit(x, width, viewWidth), top: fit(y, height, viewHeight) };
}

export function AtomMenu({ target, onClose }: { target: AtomMenuTarget; onClose: () => void }) {
  const api = useBuilderStoreApi();
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const element = useScopedBuilderStore((s) => s.element);
  const setSelected = useScopedBuilderStore((s) => s.setSelected);
  const cleaning = useCleanupRunning(api);
  const rootRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: target.x, top: target.y });

  // Measured before paint, so a menu opened near an edge never shows cut off.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setPlace(
      clampMenuPosition(
        target.x,
        target.y,
        el.offsetWidth,
        el.offsetHeight,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [target.x, target.y]);

  const shown = shownSnapshot({ source, result, showOriginal });
  const editable = canEdit({ source, result, showOriginal });

  useDismiss({ onDismiss: onClose, inside: [rootRef] });

  // The keyboard starts on the first item that can be picked.
  useEffect(() => {
    enabledItems(rootRef.current)[0]?.focus();
  }, [target.atom]);

  if (!shown || target.atom >= shown.nAtoms) return null;
  const z = shown.elements[target.atom];
  const sym = getElementSymbol(z);
  const ref = result?.refAt(target.atom) ?? null;
  const neighbours = neighboursOf(shown, target.atom);

  const items: { label: string; testId: string; disabled?: boolean; run: () => void }[] = [
    {
      label: "Select molecule",
      testId: "builder-atom-menu-molecule",
      run: () => setSelected(moleculeOf(shown, target.atom)),
    },
    {
      label: `Select all ${sym}`,
      testId: "builder-atom-menu-element",
      run: () =>
        setSelected(Array.from(shown.elements.keys()).filter((i) => shown.elements[i] === z)),
    },
    {
      label: `Set to ${getElementSymbol(element)}`,
      testId: "builder-atom-menu-set-element",
      disabled: !editable || element === z || ref === null,
      run: () => setElements(api.getState(), [target.atom], element),
    },
    ...neighbours.map((n) => ({
      label: `Remove bond to ${atomName(shown, n.index)}`,
      testId: `builder-atom-menu-unbond-${n.index}`,
      disabled: !editable || ref === null,
      run: () => removeBond(api.getState(), target.atom, n.index),
    })),
    {
      label: cleaning ? "Clean up molecule (running…)" : "Clean up molecule",
      testId: "builder-atom-menu-cleanup",
      disabled: !editable || cleaning,
      run: () => {
        setSelected(moleculeOf(shown, target.atom));
        void runCleanup(api);
      },
    },
    {
      label: "Delete atom",
      testId: "builder-atom-menu-delete",
      disabled: !editable || ref === null,
      run: () => deleteAtoms(api.getState(), [target.atom]),
    },
  ];

  // Up / Down (and Home / End) move between the items, wrapping; Enter picks.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // "Select molecule" can always be picked, so the list is never empty.
    const list = enabledItems(rootRef.current);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === "ArrowUp")
      next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Enter" && at >= 0) {
      e.preventDefault();
      list[at].click();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    list[next].focus();
  };

  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="builder-atom-menu"
      aria-label={atomName(shown, target.atom)}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        left: place.left,
        top: place.top,
        zIndex: 60,
        minWidth: 180,
        display: "flex",
        flexDirection: "column",
        padding: 4,
        borderRadius: 8,
        background: "var(--megane-surface-solid, #fff)",
        border: "1px solid var(--megane-border-solid, #e2e8f0)",
        boxShadow: "0 8px 24px var(--megane-shadow, rgba(0,0,0,0.12))",
        fontSize: 12,
        color: "var(--megane-text, #1e293b)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        style={{
          padding: "4px 10px 2px",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--megane-text-secondary, #64748b)",
        }}
      >
        {atomName(shown, target.atom)}
      </div>
      {items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-testid={item.testId}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.run();
          }}
          style={{
            textAlign: "left",
            fontSize: 12,
            padding: "6px 10px",
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: item.disabled ? "var(--megane-text-muted, #94a3b8)" : "inherit",
            cursor: item.disabled ? "default" : "pointer",
            fontFamily: "inherit",
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** The menu's items that can be picked, in order. */
function enabledItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
    (b) => !b.disabled,
  );
}
