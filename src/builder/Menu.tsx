/**
 * A small dropdown for the top bar: a trigger button and a list of items.
 * Closes on an item, a click outside, or Escape.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { buttonStyle, type ButtonVariant } from "./styles";

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  testId?: string;
  title?: string;
}

export interface MenuProps {
  label: ReactNode;
  items: MenuItem[];
  disabled?: boolean;
  variant?: ButtonVariant;
  testId?: string;
  title?: string;
}

export function Menu({ label, items, disabled = false, variant, testId, title }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const select = useCallback((item: MenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  }, []);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        style={buttonStyle(variant, disabled)}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          data-testid={testId ? `${testId}-menu` : undefined}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: 160,
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            padding: 4,
            borderRadius: 8,
            background: "var(--megane-surface-solid, #fff)",
            border: "1px solid var(--megane-border-solid, #e2e8f0)",
            boxShadow: "0 8px 24px var(--megane-shadow, rgba(0,0,0,0.12))",
          }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              data-testid={item.testId}
              disabled={item.disabled}
              title={item.title}
              onClick={() => select(item)}
              style={{
                textAlign: "left",
                fontSize: 12,
                padding: "6px 10px",
                border: "none",
                borderRadius: 6,
                background: "transparent",
                color: item.disabled ? "#94a3b8" : "var(--megane-text, #1e293b)",
                cursor: item.disabled ? "default" : "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
