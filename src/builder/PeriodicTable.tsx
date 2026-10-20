/**
 * The periodic table the tool settings open for choosing an element: every
 * element megane has a symbol for (Z 1–92) at its place in the 18-column
 * table, the lanthanides and actinides in the two rows below.
 *
 * It opens as a popover beside the Details panel, over the view, so the cells
 * are large enough to read; each is tinted by its family, carries its atomic
 * number, and the current element is filled. The empty bay at the top of the
 * table (columns 3–12, periods 1–3) describes the element under the pointer —
 * or the current one — as printed tables do: name, Z, mass, family and the
 * colour the view draws it in. The Z field beside the button still reaches any
 * Z up to 118. Escape, a click outside or a pick closes it.
 *
 * It works from the keyboard too: it opens with the current element focused,
 * the arrow keys move across the grid (Home / End to the ends of a row),
 * Enter or Space picks, typing a symbol ("F", "Fe") jumps to it, and Escape
 * closes it and gives focus back to the button that opened it.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useDismiss } from "../hooks/useDismiss";
import { createPortal } from "react-dom";
import { ELEMENT_SYMBOLS, getAtomicMass, getColor, getElementSymbol } from "../constants";
import { ACCENT, hintStyle } from "./styles";
import { ELEMENT_NAMES, FAMILIES, elementFamily } from "./elements";

/** The highest Z the table shows (the last one with a symbol). */
export const TABLE_MAX_Z = Math.max(...Object.keys(ELEMENT_SYMBOLS).map(Number));

/**
 * Row (1–7 for the periods, 9 and 10 for the lanthanides and actinides) and
 * column (1–18) of element `z` in the standard long-form table.
 */
export function tablePosition(z: number): { row: number; col: number } {
  if (z === 1) return { row: 1, col: 1 };
  if (z === 2) return { row: 1, col: 18 };
  // Periods 2 and 3: two s-block columns, then the p block at 13–18.
  for (const [row, first] of [
    [2, 3],
    [3, 11],
  ]) {
    if (z < first + 8) return { row, col: z - first < 2 ? z - first + 1 : z - first + 11 };
  }
  if (z <= 36) return { row: 4, col: z - 18 };
  if (z <= 54) return { row: 5, col: z - 36 };
  // Periods 6 and 7: the f block goes to its own row below the table.
  const [row, first] = z <= 86 ? [6, 55] : [7, 87];
  const k = z - first;
  if (k < 2) return { row, col: k + 1 };
  if (k < 17) return { row: row + 3, col: k + 1 };
  return { row, col: k - 13 };
}

/** Keys that move between cells (see {@link tableNeighbour}). */
const MOVE_KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * The element a move key goes to from `z` in the table's grid: Left / Right
 * to the nearest cell in the same row, Up / Down to the nearest row that
 * has a cell there (or the closest column in it), Home / End to the row's
 * first and last cells. `z` itself when there is nowhere to go.
 */
export function tableNeighbour(z: number, key: string, maxZ = TABLE_MAX_Z): number {
  if (!MOVE_KEYS.has(key)) return z;
  const here = tablePosition(z);
  const rowEnd = key === "Home" || key === "End";
  let best = z;
  let bestScore = Infinity;
  for (let c = 1; c <= maxZ; c++) {
    if (c === z && !rowEnd) continue;
    const p = tablePosition(c);
    const dr = p.row - here.row;
    const dc = p.col - here.col;
    let score: number;
    if (key === "ArrowRight" || key === "ArrowLeft") {
      if (dr !== 0 || (key === "ArrowRight" ? dc <= 0 : dc >= 0)) continue;
      score = Math.abs(dc);
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      if (key === "ArrowDown" ? dr <= 0 : dr >= 0) continue;
      score = Math.abs(dr) * 100 + Math.abs(dc);
    } else {
      if (dr !== 0) continue;
      score = key === "Home" ? p.col : -p.col;
    }
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The element a typed symbol names: the one whose symbol it is (any case),
 * else the lightest whose symbol starts with it; null for neither.
 */
export function typeAheadMatch(text: string, maxZ = TABLE_MAX_Z): number | null {
  const t = text.toLowerCase();
  if (!t) return null;
  let prefix: number | null = null;
  for (let z = 1; z <= maxZ; z++) {
    const sym = getElementSymbol(z).toLowerCase();
    if (sym === t) return z;
    if (prefix === null && sym.startsWith(t)) prefix = z;
  }
  return prefix;
}

/** How long a pause starts a new type-ahead symbol, ms. */
const TYPE_AHEAD_MS = 800;

const CELL = 30;
const GAP = 3;
/** Gap kept between the popover and the window's or the panel's edge. */
const EDGE = 10;

function cssColor(z: number): string {
  const [r, g, b] = getColor(z).map((c) => Math.round(c * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The element under the pointer (or the current one), in the table's top bay. */
function ElementCard({ z }: { z: number }) {
  const family = FAMILIES[elementFamily(z)];
  const mass = getAtomicMass(z);
  return (
    <div
      data-testid="builder-periodic-info"
      style={{
        gridColumn: "3 / 13",
        gridRow: "1 / 4",
        alignSelf: "center",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 10px",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "relative",
          width: 64,
          height: 64,
          flexShrink: 0,
          borderRadius: 10,
          background: `rgba(${family.rgb}, 0.16)`,
          border: `1px solid rgba(${family.rgb}, 0.45)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 5,
            left: 7,
            fontSize: 10,
            color: "var(--megane-text-secondary, #64748b)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {z}
        </span>
        <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {getElementSymbol(z)}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span
          data-testid="builder-periodic-info-name"
          style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}
        >
          {ELEMENT_NAMES[z] ?? getElementSymbol(z)}
        </span>
        <span style={{ ...hintStyle, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          Z {z}
          {mass > 0 && ` · ${mass.toFixed(mass < 100 ? 3 : 2)} u`}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "var(--megane-text-secondary, #64748b)",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: `rgb(${family.rgb})`, fontWeight: 600 }}>{family.label}</span>
          <span aria-hidden="true">·</span>
          <span
            aria-hidden="true"
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: cssColor(z),
              boxShadow: "0 0 0 1px var(--megane-border-strong, #cbd5e1)",
            }}
          />
          in the view
        </span>
      </div>
    </div>
  );
}

export function PeriodicTable({
  value,
  onPick,
  onClose,
  anchor,
}: {
  value: number;
  onPick: (z: number) => void;
  onClose: () => void;
  /**
   * The button that opened it. The popover sits beside the panel holding it
   * (to its left), level with the button; clicks on it do not count as
   * "outside".
   */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // The cell the keyboard is on (the one Tab reaches): the current element.
  const [focusZ, setFocusZ] = useState(value >= 1 && value <= TABLE_MAX_Z ? value : 1);
  const typed = useRef({ text: "", at: 0 });

  /** Give focus back to the opening button, if it was inside the table. */
  const returnFocus = useCallback(() => {
    if (rootRef.current?.contains(document.activeElement)) anchor?.current?.focus();
  }, [anchor]);
  const close = useCallback(() => {
    returnFocus();
    onClose();
  }, [returnFocus, onClose]);
  const pick = (z: number) => {
    returnFocus();
    onPick(z);
  };

  useDismiss({ onDismiss: close, inside: anchor ? [rootRef, anchor] : [rootRef] });

  const focusCell = (z: number) => {
    setFocusZ(z);
    rootRef.current?.querySelector<HTMLElement>(`[data-z="${z}"]`)?.focus();
  };

  // Once placed (and so visible, which focus needs), the current element
  // takes focus, so the keyboard can start from it.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    focusCell(focusZ);
  }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = Number((e.target as HTMLElement).dataset?.z);
    if (!at) return;
    if (MOVE_KEYS.has(e.key)) {
      e.preventDefault();
      focusCell(tableNeighbour(at, e.key));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(at);
    } else if (/^[a-z]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // A letter is never a tool shortcut while the table has focus.
      e.preventDefault();
      const now = Date.now();
      const t = typed.current;
      let text = now - t.at > TYPE_AHEAD_MS ? e.key : t.text + e.key;
      let z = typeAheadMatch(text);
      // "Fx" names nothing: start over from the "x".
      if (z === null && text !== e.key) z = typeAheadMatch((text = e.key));
      typed.current = { text, at: now };
      if (z !== null) focusCell(z);
    }
  };

  // Left of the panel the button is in, level with the button, inside the window.
  useLayoutEffect(() => {
    const button = anchor?.current;
    const width = rootRef.current?.offsetWidth ?? 0;
    const height = rootRef.current?.offsetHeight ?? 0;
    const panel = button?.closest('[data-collapsed="false"]') ?? button;
    const side = panel?.getBoundingClientRect();
    const at = button?.getBoundingClientRect();
    const left = side ? side.left - EDGE - width : EDGE;
    const top = at ? at.top - 12 : EDGE;
    setPos({
      left: Math.max(EDGE, left),
      top: Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE)),
    });
  }, [anchor]);

  const cells = Array.from({ length: TABLE_MAX_Z }, (_, i) => i + 1);
  const shown = hovered ?? value;

  return createPortal(
    <div
      ref={rootRef}
      data-testid="builder-periodic-table"
      role="dialog"
      aria-label="Periodic table"
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
        zIndex: 900,
        padding: 14,
        borderRadius: 12,
        background: "var(--megane-surface-solid, #f8f9fb)",
        border: "1px solid var(--megane-border-solid, #e2e8f0)",
        boxShadow: "0 16px 40px var(--megane-shadow-strong, rgba(0, 0, 0, 0.15))",
        color: "var(--megane-text, #1e293b)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Periodic table</span>
        <span style={{ ...hintStyle, fontSize: 11 }}>
          Click an element, or move with the arrow keys and press Enter; type a symbol to jump
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="builder-periodic-close"
          aria-label="Close the periodic table"
          onClick={close}
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: "2px 4px",
            color: "var(--megane-text-muted, #94a3b8)",
          }}
        >
          ×
        </button>
      </div>
      <div
        role="group"
        aria-label="Elements"
        onMouseLeave={() => setHovered(null)}
        onKeyDown={onGridKeyDown}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(18, ${CELL}px)`,
          gridTemplateRows: `repeat(7, ${CELL}px) 10px repeat(2, ${CELL}px)`,
          gap: GAP,
        }}
      >
        <ElementCard z={shown} />
        {cells.map((z) => {
          const { row, col } = tablePosition(z);
          const sym = getElementSymbol(z);
          const rgb = FAMILIES[elementFamily(z)].rgb;
          const active = z === value;
          const hot = z === hovered;
          return (
            <button
              key={z}
              type="button"
              data-testid={`builder-periodic-${sym}`}
              data-z={z}
              tabIndex={z === focusZ ? 0 : -1}
              aria-pressed={active}
              aria-label={`${ELEMENT_NAMES[z] ?? sym} (Z = ${z})`}
              title={`${ELEMENT_NAMES[z] ?? sym} (Z = ${z})`}
              onClick={() => pick(z)}
              onMouseEnter={() => setHovered(z)}
              onFocus={() => {
                setHovered(z);
                setFocusZ(z);
              }}
              style={{
                gridRow: row,
                gridColumn: col,
                position: "relative",
                width: CELL,
                height: CELL,
                padding: 0,
                borderRadius: 6,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1,
                transition: "background 80ms, border-color 80ms, transform 80ms",
                transform: hot && !active ? "translateY(-1px)" : "none",
                border: active
                  ? `1px solid ${ACCENT}`
                  : `1px solid rgba(${rgb}, ${hot ? 0.7 : 0.28})`,
                background: active ? ACCENT : `rgba(${rgb}, ${hot ? 0.3 : 0.13})`,
                color: active ? "#fff" : "var(--megane-text, #1e293b)",
                boxShadow: active ? "0 2px 6px rgba(59, 130, 246, 0.35)" : "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: 2,
                  left: 3,
                  fontSize: 7,
                  fontWeight: 500,
                  opacity: active ? 0.85 : 0.55,
                }}
              >
                {z}
              </span>
              <span style={{ position: "relative", top: 3 }}>{sym}</span>
            </button>
          );
        })}
        {/* Where the lanthanides and actinides sit in the main table. */}
        {[6, 7].map((row) => {
          const rgb = FAMILIES[row === 6 ? "lanthanide" : "actinide"].rgb;
          return (
            <span
              key={row}
              aria-hidden="true"
              style={{
                gridRow: row,
                gridColumn: 3,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                border: `1px dashed rgba(${rgb}, 0.5)`,
                fontSize: 8,
                color: "var(--megane-text-secondary, #64748b)",
              }}
            >
              {row === 6 ? "57–71" : "89–103"}
            </span>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
