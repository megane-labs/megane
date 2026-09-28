/**
 * The toolbar vocabulary of megane's floating panels: small tinted pill
 * buttons in rows headed by an uppercase category label, and the dropdowns
 * those buttons open. The viewer's Pipeline panel and megane Builder's panel
 * both paint with these, so the two apps share one look.
 */

import type { CSSProperties } from "react";

/** Shared base for the icon + text pill buttons. */
export const textBtnBase: CSSProperties = {
  borderRadius: 5,
  padding: "3px 6px",
  cursor: "pointer",
  fontSize: 10.5,
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  whiteSpace: "nowrap",
  lineHeight: 1,
};

/**
 * A pill button tinted with `rgb` ("59, 130, 246"): an 8 % fill, a border at
 * `borderAlpha` and `color` for the text and icon.
 */
export function tintedButtonStyle(rgb: string, color: string, borderAlpha = 0.25): CSSProperties {
  return {
    ...textBtnBase,
    background: `rgba(${rgb}, 0.08)`,
    border: `1px solid rgba(${rgb}, ${borderAlpha})`,
    color,
  };
}

/** One labelled row of the panel header's toolbar. */
export const toolbarRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexBasis: "100%",
  flexWrap: "wrap",
  rowGap: 4,
};

/** The uppercase category label at the start of a toolbar row. */
export const toolbarCategoryLabelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: "var(--megane-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginRight: 2,
  width: 64,
  flexShrink: 0,
};

/** A toolbar button's dropdown list. */
export const dropdownStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 4,
  background: "var(--megane-surface-solid)",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  boxShadow: "0 4px 12px var(--megane-shadow)",
  zIndex: 100,
  minWidth: 180,
  padding: "4px 0",
};

export const dropdownItemStyle: CSSProperties = {
  display: "block",
  width: "100%",
  background: "none",
  border: "none",
  padding: "6px 14px 6px 20px",
  cursor: "pointer",
  fontSize: 12,
  color: "var(--megane-text)",
  textAlign: "left",
};

/** A small uppercase heading over a group of dropdown items. */
export const groupHeaderStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--megane-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "6px 14px 2px",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

/**
 * The small buttons that float straight on the 3D view (Reset View, the axis
 * buttons): translucent surface, light blur, square-ish corners.
 */
export const overlayButtonStyle: CSSProperties = {
  padding: "4px 8px",
  fontSize: 11,
  lineHeight: 1,
  background: "var(--megane-surface)",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 4,
  cursor: "pointer",
  color: "var(--megane-text-body)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
  userSelect: "none",
};

/** A floating frosted-glass card over the 3D view (panels, bars, HUDs). */
export const floatingSurfaceStyle: CSSProperties = {
  background: "var(--megane-surface)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  borderRadius: 12,
  boxShadow: "0 1px 8px var(--megane-shadow)",
  border: "1px solid var(--megane-border)",
};
