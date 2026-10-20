/**
 * A dropdown for the Builder: a trigger (a pill in the viewer's toolbar look
 * by default, or an icon button on the operations rail) and a list of items,
 * optionally split by separators and headed by captions. Closes on an item,
 * a click outside, or Escape.
 *
 * From the keyboard, as a menu button: Enter, Space or ↓ on the trigger
 * opens it on the first item (↑ on the last), ↑ ↓ Home End move between the
 * items that can run (disabled ones are skipped), Enter runs one, and Escape
 * or Tab closes it — Escape giving focus back to the trigger. A disabled
 * item keeps its `title`, which can say why it cannot run.
 *
 * The list is portalled to `<body>` and placed under (or beside) the trigger
 * with fixed coordinates, kept inside the window: the rail it sits in scrolls
 * and clips its overflow, and a backdrop blur would capture fixed positioning.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useDismiss } from "../hooks/useDismiss";
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

/**
 * The part of the window a menu may use: the window, narrowed to the Builder
 * the trigger belongs to. Embedded in a notebook the page can be far taller
 * than what is on screen (a VS Code notebook draws its outputs in one tall
 * webview), so a menu kept inside the Builder stays where the user looks.
 */
export function menuBounds(
  trigger: Element,
  win: Pick<Window, "innerWidth" | "innerHeight"> = window,
): { left: number; top: number; right: number; bottom: number } {
  const bounds = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  const builder = trigger.closest('[data-testid="megane-builder"]');
  if (!builder) return bounds;
  const r = builder.getBoundingClientRect();
  // A Builder too small to hold anything (not laid out yet) does not narrow it.
  if (r.width <= 0 || r.height <= 0) return bounds;
  return {
    left: Math.max(bounds.left, r.left),
    top: Math.max(bounds.top, r.top),
    right: Math.min(bounds.right, r.right),
    bottom: Math.min(bounds.bottom, r.bottom),
  };
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
  const [pos, setPos] = useState<{ left: number; top: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Which item takes focus once the list is placed: from the keyboard the
  // first (or last); a click leaves focus on the trigger.
  const focusOnOpen = useRef<"first" | "last" | null>(null);

  /** The items that can run, in order. */
  const enabledItems = () =>
    [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter(
      (el) => !(el as HTMLButtonElement).disabled,
    );

  /** Close; focus goes back to the trigger if it was in the list. */
  const close = useCallback(() => {
    if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setOpen(false);
  }, []);

  useDismiss({ onDismiss: close, enabled: open, inside: [triggerRef, menuRef] });

  // Under the trigger (or beside it), pulled back when it would run off the
  // window or out of the Builder (see `menuBounds`).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null);
      return;
    }
    const at = triggerRef.current.getBoundingClientRect();
    const box = menuBounds(triggerRef.current);
    const width = menuRef.current?.offsetWidth ?? 0;
    const height = menuRef.current?.offsetHeight ?? 0;
    const maxLeft = box.right - width - EDGE;
    const maxTop = box.bottom - height - EDGE;
    const left = placement === "right" ? at.right + 8 : at.left;
    const top = placement === "right" ? at.top : at.bottom + 4;
    setPos({
      left: Math.max(box.left + EDGE, Math.min(left, maxLeft)),
      top: placement === "right" ? Math.max(box.top + EDGE, Math.min(top, maxTop)) : top,
      bottom: box.bottom,
    });
  }, [open, placement]);

  // Once placed (a hidden list cannot take focus), move into it if asked.
  useLayoutEffect(() => {
    if (!pos || !focusOnOpen.current) return;
    const list = enabledItems();
    (focusOnOpen.current === "first" ? list[0] : list[list.length - 1])?.focus();
    focusOnOpen.current = null;
  }, [pos]);

  const select = useCallback(
    (item: MenuAction) => {
      if (item.disabled) return;
      close();
      item.onSelect();
    },
    [close],
  );

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const where =
      e.key === "ArrowDown" || e.key === "Enter" || e.key === " "
        ? "first"
        : e.key === "ArrowUp"
          ? "last"
          : null;
    if (!where || disabled) return;
    e.preventDefault();
    if (open) {
      // Already open (from a click): step into it.
      const list = enabledItems();
      (where === "first" ? list[0] : list[list.length - 1])?.focus();
      return;
    }
    focusOnOpen.current = where;
    setOpen(true);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const list = enabledItems();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    let j: number;
    switch (e.key) {
      case "ArrowDown":
        j = i < 0 ? 0 : (i + 1) % list.length;
        break;
      case "ArrowUp":
        j = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
        break;
      case "Home":
        j = 0;
        break;
      case "End":
        j = list.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    list[j].focus();
  };

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
        onKeyDown={onTriggerKeyDown}
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
            aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
            data-testid={testId ? `${testId}-menu` : undefined}
            onKeyDown={onMenuKeyDown}
            style={{
              ...dropdownStyle,
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              right: "auto",
              marginTop: 0,
              zIndex: 1000,
              maxHeight: pos ? Math.max(0, pos.bottom - pos.top - EDGE) : undefined,
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
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
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
