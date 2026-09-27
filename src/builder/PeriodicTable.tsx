/**
 * The periodic table the context bar opens for choosing an element: every
 * element megane has a symbol for (Z 1–92) at its place in the 18-column
 * table, the lanthanides and actinides in the two rows below. Each cell is
 * tinted with the colour the view draws that element in; the current element
 * is highlighted. The Z field beside it still reaches any Z up to 118.
 */

import { useEffect } from "react";
import { ELEMENT_SYMBOLS, getColor, getElementSymbol } from "../constants";

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

const ACCENT = "#2563eb";

function tint(z: number, alpha: number): string {
  const [r, g, b] = getColor(z).map((c) => Math.round(c * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function PeriodicTable({
  value,
  onPick,
  onClose,
}: {
  value: number;
  onPick: (z: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const cells = Array.from({ length: TABLE_MAX_Z }, (_, i) => i + 1);
  return (
    <div
      data-testid="builder-periodic-table"
      role="dialog"
      aria-label="Periodic table"
      style={{
        pointerEvents: "auto",
        maxWidth: "100%",
        overflowX: "auto",
        boxSizing: "border-box",
        padding: 10,
        borderRadius: 10,
        background: "var(--megane-surface-solid, #fff)",
        border: "1px solid var(--megane-border-solid, #e2e8f0)",
        boxShadow: "0 6px 20px var(--megane-shadow, rgba(15, 23, 42, 0.08))",
        color: "var(--megane-text, #1e293b)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(18, 26px)",
          gridTemplateRows: "repeat(7, 26px) 8px repeat(2, 26px)",
          gap: 2,
        }}
      >
        {cells.map((z) => {
          const { row, col } = tablePosition(z);
          const sym = getElementSymbol(z);
          const active = z === value;
          return (
            <button
              key={z}
              type="button"
              data-testid={`builder-periodic-${sym}`}
              aria-pressed={active}
              title={`${sym} (Z = ${z})`}
              onClick={() => onPick(z)}
              style={{
                gridRow: row,
                gridColumn: col,
                width: 26,
                height: 26,
                padding: 0,
                border: active ? `2px solid ${ACCENT}` : "1px solid transparent",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                background: active ? ACCENT : tint(z, 0.35),
                color: active ? "#fff" : "var(--megane-text, #1e293b)",
              }}
            >
              {sym}
            </button>
          );
        })}
        {/* Where the lanthanides and actinides sit in the main table. */}
        {[6, 7].map((row) => (
          <span
            key={row}
            aria-hidden="true"
            style={{
              gridRow: row,
              gridColumn: 3,
              alignSelf: "center",
              justifySelf: "center",
              fontSize: 10,
              color: "var(--megane-text-secondary, #64748b)",
            }}
          >
            {row === 6 ? "57–71" : "89–"}
          </span>
        ))}
      </div>
    </div>
  );
}
