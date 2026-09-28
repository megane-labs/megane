/**
 * The toolbar in the Builder panel's header, built like the viewer's Pipeline
 * panel: rows headed by an uppercase category label, holding small tinted
 * pill buttons.
 *
 *   Document — the File menu (open, new, save), Undo, Redo
 *   Others   — the theme
 *
 * The panel owns the document; what acts on the structure (Structure,
 * Insert, Tools) is on the operations rail left of the view
 * (`OperationsRail`), beside the tools. The File pill wears the viewer's
 * cyan for files (its Export), the rest grey.
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

const fileStyle = tintedButtonStyle("6, 182, 212", "#06b6d4");
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
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** ⌘ or Ctrl, for the shortcut hints. */
  mod: string;
}

export function BuilderToolbar({
  fileItems,
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
      <Row label="Others" testId="builder-toolbar-others">
        <ThemeCycleButton testId="builder-theme" />
      </Row>
    </>
  );
}
