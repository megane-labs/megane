/**
 * The pieces the Builder's two floating rails (tools, operations) are made
 * of: the frosted column, its 38 px icon buttons and 20 px stroke icons, the
 * rule between groups, and the small mark in a button's corner.
 */

import type { CSSProperties, ReactNode } from "react";
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
