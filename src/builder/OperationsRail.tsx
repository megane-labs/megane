/**
 * The operations rail: a second floating column under the tool rail, on the
 * left of the view, holding what acts on the structure as a whole — the
 * Structure menu (cell, supercell, slab, symmetry, clean-up), Insert (library
 * molecules, a sketch, a file) and Tools (the Python tool server). The tools
 * above it act on a click; these act at once or through a dialog, so they are
 * menus, and each list opens to the right of its button. The document itself
 * (File, Undo / Redo) stays in the Builder panel on the right.
 */

import type { ReactNode } from "react";
import { Menu, type MenuItem } from "./Menu";
import { TOOL_RAIL_WIDTH, railButtonStyle } from "./ToolRail";
import { floatingSurfaceStyle } from "../components/toolbarStyles";

// 20 px stroke icons in the tool rail's style.
function RailIcon({ children }: { children: ReactNode }) {
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

const IconStructure = (
  <RailIcon>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </RailIcon>
);

const IconInsert = (
  <RailIcon>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </RailIcon>
);

const IconTools = (
  <RailIcon>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </RailIcon>
);

/** The small ▸ in the corner that says "this opens a menu". */
function FlyoutMark() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        right: 3,
        bottom: 1,
        fontSize: 8,
        color: "var(--megane-text-muted, #94a3b8)",
      }}
    >
      ▸
    </span>
  );
}

export interface OperationsRailProps {
  structureItems: MenuItem[];
  insertItems: MenuItem[];
  toolsItems: MenuItem[];
  /** Whether a structure is open (the Structure menu needs one). */
  hasDocument: boolean;
}

export function OperationsRail({
  structureItems,
  insertItems,
  toolsItems,
  hasDocument,
}: OperationsRailProps) {
  const entries: {
    testId: string;
    label: string;
    title: string;
    icon: ReactNode;
    items: MenuItem[];
    disabled?: boolean;
  }[] = [
    {
      testId: "builder-structure",
      label: "Structure",
      title: "Structure: cell, supercell, slab and symmetry of the open structure",
      icon: IconStructure,
      items: structureItems,
      disabled: !hasDocument,
    },
    {
      testId: "builder-insert",
      label: "Insert",
      title: "Insert: molecules from the library, a sketch or a file",
      icon: IconInsert,
      items: insertItems,
    },
    {
      testId: "builder-tools",
      label: "Tools",
      title: "Tools: Python tools from a connected tool server",
      icon: IconTools,
      items: toolsItems,
    },
  ];

  return (
    <div
      data-testid="builder-operations-rail"
      role="toolbar"
      aria-label="Operations"
      aria-orientation="vertical"
      style={{
        ...floatingSurfaceStyle,
        width: TOOL_RAIL_WIDTH,
        boxSizing: "border-box",
        padding: "6px 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        pointerEvents: "auto",
      }}
    >
      {entries.map((e) => (
        <Menu
          key={e.testId}
          testId={e.testId}
          label={
            <>
              {e.icon}
              <FlyoutMark />
            </>
          }
          ariaLabel={e.label}
          title={e.title}
          disabled={e.disabled}
          placement="right"
          caret={false}
          triggerStyle={railButtonStyle(false)}
          openTriggerStyle={railButtonStyle(true)}
          heading={e.label}
          items={e.items}
        />
      ))}
    </div>
  );
}
