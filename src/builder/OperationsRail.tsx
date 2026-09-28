/**
 * The operations rail: a second floating column under the tool rail, on the
 * left of the view, holding every action — the tools above it act on a
 * click, these act at once or through a menu or dialog. Top to bottom:
 *
 *   File                      — open, new, save (the document)
 *   Structure, Insert, Tools  — what acts on the structure as a whole
 *   Undo, Redo                — the history
 *   Theme                     — Light → Dark → Auto, as in the viewer
 *
 * Menus open to the right of their button. The panel on the right of the
 * view shows details only (inspector, cell, history).
 */

import type { ReactNode } from "react";
import { Fragment } from "react";
import { Menu, type MenuItem } from "./Menu";
import { ThemeCycleButton } from "../components/ThemeCycleButton";
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

const IconFile = (
  <RailIcon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </RailIcon>
);

const IconUndo = (
  <RailIcon>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </RailIcon>
);

const IconRedo = (
  <RailIcon>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </RailIcon>
);

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

function Divider() {
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

function disabledRail(disabled: boolean): React.CSSProperties {
  return {
    ...railButtonStyle(false),
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? "default" : "pointer",
  };
}

export interface OperationsRailProps {
  fileItems: MenuItem[];
  structureItems: MenuItem[];
  insertItems: MenuItem[];
  toolsItems: MenuItem[];
  /** Whether a structure is open (the Structure menu needs one). */
  hasDocument: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** ⌘ or Ctrl, for the shortcut hints. */
  mod: string;
}

export function OperationsRail({
  fileItems,
  structureItems,
  insertItems,
  toolsItems,
  hasDocument,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  mod,
}: OperationsRailProps) {
  const menus: {
    testId: string;
    label: string;
    title: string;
    icon: ReactNode;
    items: MenuItem[];
    disabled?: boolean;
  }[][] = [
    [
      {
        testId: "builder-file",
        label: "File",
        title: `File: open (${mod}+O), start or save (${mod}+S) a structure`,
        icon: IconFile,
        items: fileItems,
      },
    ],
    [
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
    ],
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
      {menus.map((group, g) => (
        <Fragment key={g}>
          {g > 0 && <Divider />}
          {group.map((e) => (
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
        </Fragment>
      ))}
      <Divider />
      <button
        type="button"
        data-testid="builder-topbar-undo"
        aria-label="Undo"
        title={`Undo (${mod}+Z)`}
        disabled={!canUndo}
        style={disabledRail(!canUndo)}
        onClick={onUndo}
      >
        {IconUndo}
      </button>
      <button
        type="button"
        data-testid="builder-topbar-redo"
        aria-label="Redo"
        title={`Redo (${mod}+Shift+Z)`}
        disabled={!canRedo}
        style={disabledRail(!canRedo)}
        onClick={onRedo}
      >
        {IconRedo}
      </button>
      <Divider />
      <ThemeCycleButton
        testId="builder-theme"
        style={railButtonStyle(false)}
        iconOnly
        iconSize={18}
      />
    </div>
  );
}
