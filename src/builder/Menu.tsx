/**
 * A dropdown for the Builder: a trigger (a pill in the viewer's toolbar look
 * by default, or an icon button on the operations rail) and a list of items,
 * optionally split by separators and headed by captions. Closes on an item,
 * a click outside, or Escape.
 *
 * The list is portalled to `<body>` and placed under (or beside) the trigger
 * with fixed coordinates, kept inside the window: the rail it sits in scrolls
 * and clips its overflow, and a backdrop blur would capture fixed positioning.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  dropdownItemStyle,
  dropdownStyle,
  groupHeaderStyle,
  tintedButtonStyle,
} from "../components/toolbarStyles";

export interface MenuAction {
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  testId?: string;
  title?: string;
}

/** A thin rule between groups of items. */
export interface MenuSeparator {
  separator: true;
}

/** A small uppercase heading over the items that follow it. */
export interface MenuCaption {
  caption: ReactNode;
  testId?: string;
}

export type MenuItem = MenuAction | MenuSeparator | MenuCaption;

function isAction(item: MenuItem): item is MenuAction {
  return "onSelect" in item;
}

/** The neutral pill a trigger wears unless it is given its own tint. */
export const MENU_TRIGGER_STYLE = tintedButtonStyle(
  "100, 116, 139",
  "var(--megane-text-body)",
  0.3,
);

/** Gap kept between the list and the window's edges. */
const EDGE = 8;

export interface MenuProps {
  label: ReactNode;
  items: MenuItem[];
  disabled?: boolean;
  /** The trigger's pill style (default: {@link MENU_TRIGGER_STYLE}). */
  triggerStyle?: CSSProperties;
  /**
   * Where the list opens: under the trigger (a toolbar pill) or beside it,
   * to its right (an icon button on the left rail).
   */
  placement?: "below" | "right";
  /** Show the ▼ caret after the label (default: true). */
  caret?: boolean;
  /** The trigger's style while its list is open (default: `triggerStyle`). */
  openTriggerStyle?: CSSProperties;
  /** A title over the list, for a trigger that is only an icon. */
  heading?: ReactNode;
  testId?: string;
  title?: string;
  /** Accessible name when the label is only an icon. */
  ariaLabel?: string;
}

export function Menu({
  label,
  items,
  disabled = false,
  triggerStyle,
  placement = "below",
  caret = true,
  openTriggerStyle,
  heading,
  testId,
  title,
  ariaLabel,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
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

  // Under the trigger (or beside it), pulled back when it would run off the
  // window.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null);
      return;
    }
    const at = triggerRef.current.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth ?? 0;
    const height = menuRef.current?.offsetHeight ?? 0;
    const maxLeft = window.innerWidth - width - EDGE;
    const maxTop = window.innerHeight - height - EDGE;
    const left = placement === "right" ? at.right + 8 : at.left;
    const top = placement === "right" ? at.top : at.bottom + 4;
    setPos({
      left: Math.max(EDGE, Math.min(left, maxLeft)),
      top: placement === "right" ? Math.max(EDGE, Math.min(top, maxTop)) : top,
    });
  }, [open, placement]);

  const select = useCallback((item: MenuAction) => {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        style={{
          ...((open && openTriggerStyle) || triggerStyle || MENU_TRIGGER_STYLE),
          fontFamily: "inherit",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.45 : 1,
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {caret && (
          <span aria-hidden="true" style={{ fontSize: 8, opacity: 0.7 }}>
            ▼
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-testid={testId ? `${testId}-menu` : undefined}
            style={{
              ...dropdownStyle,
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              right: "auto",
              marginTop: 0,
              zIndex: 1000,
              maxHeight: `calc(100vh - ${(pos?.top ?? 0) + EDGE}px)`,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              // Hidden for the one frame before it has been measured and placed.
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {heading && (
              <div
                data-testid={testId ? `${testId}-heading` : undefined}
                style={{
                  padding: "4px 14px 6px",
                  marginBottom: 2,
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  whiteSpace: "nowrap",
                  color: "var(--megane-text, #1e293b)",
                  borderBottom: "1px solid var(--megane-border-solid, #e2e8f0)",
                }}
              >
                {heading}
              </div>
            )}
            {items.map((item, i) => {
              if ("separator" in item) {
                return (
                  <div
                    key={i}
                    role="separator"
                    style={{
                      height: 1,
                      margin: "4px 0",
                      background: "var(--megane-border-solid, #e2e8f0)",
                    }}
                  />
                );
              }
              if (!isAction(item)) {
                return (
                  <div
                    key={i}
                    data-testid={item.testId}
                    style={{ ...groupHeaderStyle, whiteSpace: "nowrap" }}
                  >
                    {item.caption}
                  </div>
                );
              }
              return (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  data-testid={item.testId}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => select(item)}
                  style={{
                    ...dropdownItemStyle,
                    padding: "6px 14px",
                    fontFamily: "inherit",
                    whiteSpace: "nowrap",
                    color: item.disabled
                      ? "var(--megane-text-muted, #94a3b8)"
                      : "var(--megane-text, #1e293b)",
                    cursor: item.disabled ? "default" : "pointer",
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
