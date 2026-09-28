/**
 * The menu a right-click on an atom opens: select its molecule or every atom
 * of its element, change it to the current element, delete it, or clean up
 * its molecule's geometry. Closes on a choice, a click elsewhere, or Escape.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "./store";
import { getElementSymbol } from "../constants";
import { moleculeOf } from "./geometry";
import { runCleanup } from "./cleanup";

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
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const element = useBuilderStore((s) => s.element);
  const setSelected = useBuilderStore((s) => s.setSelected);
  const pushOp = useBuilderStore((s) => s.pushOp);
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

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  if (!shown || target.atom >= shown.nAtoms) return null;
  const z = shown.elements[target.atom];
  const sym = getElementSymbol(z);
  const ref = result?.refAt(target.atom) ?? null;

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
      run: () => pushOp({ op: "set_element", atoms: [ref!], element }),
    },
    {
      label: "Clean up molecule",
      testId: "builder-atom-menu-cleanup",
      disabled: !editable,
      run: () => {
        setSelected(moleculeOf(shown, target.atom));
        void runCleanup(useBuilderStore);
      },
    },
    {
      label: "Delete atom",
      testId: "builder-atom-menu-delete",
      disabled: !editable || ref === null,
      run: () => {
        setSelected([]);
        pushOp({ op: "delete_atoms", atoms: [ref!] });
      },
    },
  ];

  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="builder-atom-menu"
      aria-label={`${sym} #${target.atom}`}
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
        {sym} #{target.atom}
      </div>
      {items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
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
