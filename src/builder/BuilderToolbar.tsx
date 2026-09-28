/**
 * The toolbar in the Builder panel's header, built like the viewer's Pipeline
 * panel: rows headed by an uppercase category label, holding small tinted
 * pill buttons.
 *
 *   Document — the File menu (open, new, save), Undo, Redo
 *   Build    — the Structure, Insert and Tools menus
 *   Others   — the theme
 *
 * The tint says what kind of thing a button does, with the viewer's colours:
 * cyan for files (the viewer's Export), violet for whole-structure operations
 * (its Templates), blue for adding things (its Add node), amber for the tool
 * server (its Render), grey for the rest.
 */

import type { ReactNode } from "react";
import { Menu, type MenuItem } from "./Menu";
import { ThemeCycleButton } from "../components/ThemeCycleButton";
import {
  tintedButtonStyle,
  toolbarCategoryLabelStyle,
  toolbarRowStyle,
} from "../components/toolbarStyles";

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
  focusable: "false" as const,
  style: { flexShrink: 0, width: 12, height: 12 } as React.CSSProperties,
};

const IconFile = (
  <svg {...iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const IconUndo = (
  <svg {...iconProps}>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </svg>
);

const IconRedo = (
  <svg {...iconProps}>
    <polyline points="15 14 20 9 15 4" />
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
  </svg>
);

const IconStructure = (
  <svg {...iconProps}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
);

const IconInsert = (
  <svg {...iconProps} strokeWidth="2.5">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconTools = (
  <svg {...iconProps}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const fileStyle = tintedButtonStyle("6, 182, 212", "#06b6d4");
const structureStyle = tintedButtonStyle("139, 92, 246", "#8b5cf6");
const insertStyle = tintedButtonStyle("59, 130, 246", "var(--megane-primary)");
const toolsStyle = tintedButtonStyle("245, 158, 11", "#f59e0b");
const historyStyle = tintedButtonStyle("100, 116, 139", "var(--megane-text-secondary)", 0.3);

function Row({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div style={toolbarRowStyle} data-testid={testId}>
      <span style={toolbarCategoryLabelStyle}>{label}</span>
      {children}
    </div>
  );
}

export interface BuilderToolbarProps {
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

export function BuilderToolbar({
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
}: BuilderToolbarProps) {
  return (
    <>
      <Row label="Document" testId="builder-toolbar-document">
        <Menu
          testId="builder-file"
          label={<>{IconFile} File</>}
          title="Open, start or save a structure"
          triggerStyle={fileStyle}
          items={fileItems}
        />
        <button
          type="button"
          data-testid="builder-topbar-undo"
          style={{
            ...historyStyle,
            opacity: canUndo ? 1 : 0.45,
            cursor: canUndo ? "pointer" : "default",
          }}
          disabled={!canUndo}
          title={`Undo (${mod}+Z)`}
          onClick={onUndo}
        >
          {IconUndo} Undo
        </button>
        <button
          type="button"
          data-testid="builder-topbar-redo"
          style={{
            ...historyStyle,
            opacity: canRedo ? 1 : 0.45,
            cursor: canRedo ? "pointer" : "default",
          }}
          disabled={!canRedo}
          title={`Redo (${mod}+Shift+Z)`}
          onClick={onRedo}
        >
          {IconRedo} Redo
        </button>
      </Row>
      <Row label="Build" testId="builder-toolbar-build">
        <Menu
          testId="builder-structure"
          label={<>{IconStructure} Structure</>}
          disabled={!hasDocument}
          title="Cell, supercell, slab and symmetry of the open structure"
          triggerStyle={structureStyle}
          items={structureItems}
        />
        <Menu
          testId="builder-insert"
          label={<>{IconInsert} Insert</>}
          title="Molecules from the library, a sketch or a file"
          triggerStyle={insertStyle}
          items={insertItems}
        />
        <Menu
          testId="builder-tools"
          label={<>{IconTools} Tools</>}
          title="Python tools from a connected tool server"
          triggerStyle={toolsStyle}
          items={toolsItems}
        />
      </Row>
      <Row label="Others" testId="builder-toolbar-others">
        <ThemeCycleButton testId="builder-theme" />
      </Row>
    </>
  );
}
