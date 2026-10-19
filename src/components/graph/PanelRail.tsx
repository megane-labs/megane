/**
 * The column of icon buttons down the left edge of a node-graph editor's
 * panel, made like megane Builder's tool and operations rails (same 38 px
 * buttons, 20 px stroke icons, rules between groups, ▸ on a button that
 * opens a menu, menus opening to its right). The viewer's Pipeline rail and
 * Builder's Flow rail are both built from these pieces.
 */

import type { CSSProperties, ReactNode } from "react";
import { Menu, type MenuItem } from "../../builder/Menu";
import { FlyoutMark, TOOL_RAIL_WIDTH, railButtonStyle } from "../../builder/rail";

export const PANEL_RAIL_WIDTH = TOOL_RAIL_WIDTH;

const railColumnStyle: CSSProperties = {
  width: PANEL_RAIL_WIDTH,
  flexShrink: 0,
  boxSizing: "border-box",
  padding: "6px 0",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  overflowY: "auto",
  overflowX: "hidden",
  borderRight: "1px solid var(--megane-border)",
};

/** The rail itself: a toolbar column. */
export function PanelRail({
  testId,
  label,
  children,
}: {
  testId: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      role="toolbar"
      aria-label={label}
      aria-orientation="vertical"
      style={railColumnStyle}
    >
      {children}
    </div>
  );
}

/** An icon button that acts at once. */
export function RailButton({
  testId,
  label,
  title,
  icon,
  onClick,
  active = false,
  disabled = false,
}: {
  testId: string;
  label: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={title}
      disabled={disabled}
      style={disabled ? { ...railButtonStyle(active), opacity: 0.45 } : railButtonStyle(active)}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/** An icon button that opens a menu to its right. */
export function RailMenu({
  testId,
  label,
  title,
  icon,
  items,
}: {
  testId: string;
  label: string;
  title: string;
  icon: ReactNode;
  items: MenuItem[];
}) {
  return (
    <Menu
      testId={testId}
      label={
        <>
          {icon}
          <FlyoutMark />
        </>
      }
      ariaLabel={label}
      title={title}
      placement="right"
      caret={false}
      triggerStyle={railButtonStyle(false)}
      openTriggerStyle={railButtonStyle(true)}
      heading={label}
      items={items}
    />
  );
}

/** The room between the rail's top groups and the ones kept at its foot. */
export function RailSpacer() {
  return <div style={{ flex: 1, minHeight: 6 }} />;
}
