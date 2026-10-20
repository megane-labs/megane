/**
 * The Flow panel's rail: a column of icon buttons down the panel's left edge,
 * built from the same pieces as the viewer's Pipeline rail
 * (`components/graph/PanelRail`). Top to bottom:
 *
 *   Add, Templates, Layout — build the graph
 *   Undo, Redo    — step through the graph's changes
 *   Run / Stop    — build every block (or stop the run)
 *   File          — open / save the flow as JSON, clear it
 *   Theme         — at the foot, as in the viewer
 *
 * The menus are pure item lists (`addMenuItems`, `templateMenuItems`,
 * `flowFileMenuItems`) so the rail and its tests read the same thing.
 */

import { useRef } from "react";
import type { MenuItem } from "../Menu";
import { ThemeCycleButton } from "../../components/ThemeCycleButton";
import { PanelRail, RailButton, RailMenu, RailSpacer } from "../../components/graph/PanelRail";
import { RailDivider, RailIcon, railButtonStyle } from "../rail";
import type { BuilderToolInfo } from "../tools/contract";
import { toolsMenuItems } from "../tools/ToolServer";
import type { ToolsStore } from "../tools/store";
import type { BuiltinType } from "./builtins";
import { FLOW_TEMPLATES } from "./templates";

const IconAdd = (
  <RailIcon>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </RailIcon>
);

const IconTemplates = (
  <RailIcon>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <path d="M17 13.5v7M13.5 17h7" />
  </RailIcon>
);

const IconLayout = (
  <RailIcon>
    <rect x="9" y="3" width="6" height="4.5" rx="1" />
    <rect x="3" y="16.5" width="6" height="4.5" rx="1" />
    <rect x="15" y="16.5" width="6" height="4.5" rx="1" />
    <path d="M12 7.5V12M6 16.5V12h12v4.5" />
  </RailIcon>
);

const IconFile = (
  <RailIcon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </RailIcon>
);

const IconRun = (
  <RailIcon>
    <path d="M7 4.5v15l12-7.5z" />
  </RailIcon>
);

const IconUndo = (
  <RailIcon>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </RailIcon>
);

const IconRedo = (
  <RailIcon>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </RailIcon>
);

const IconStop = (
  <RailIcon>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </RailIcon>
);

export interface AddMenuActions {
  addSmiles: () => void;
  addLibrary: () => void;
  addDocument: () => void;
  /** Add one of the blocks Builder runs itself (crystal, slab, polymer, …). */
  addBuiltin: (type: BuiltinType) => void;
  addTool: (tool: BuilderToolInfo) => void;
  /** Show the tool server form. */
  openServer: () => void;
  /** The tools store's connection state; omitted on a host without tool servers. */
  tools?: Pick<ToolsStore, "status" | "connection"> &
    Partial<Pick<ToolsStore, "servers" | "setUrl" | "connect">>;
}

export function addMenuItems(a: AddMenuActions): MenuItem[] {
  const items: MenuItem[] = [
    { caption: "Structures" },
    {
      label: "Molecule from SMILES",
      testId: "builder-flow-add-smiles",
      title: "A molecule written as SMILES, embedded in 3D by RDKit",
      onSelect: a.addSmiles,
    },
    {
      label: "Molecule from the library",
      testId: "builder-flow-add-library",
      title: "A preset or one of your saved molecules",
      onSelect: a.addLibrary,
    },
    {
      label: "Manual structure",
      testId: "builder-flow-add-document",
      title: "The structure open in Manual mode",
      onSelect: a.addDocument,
    },
    {
      label: "Bulk crystal",
      testId: "builder-flow-add-crystal",
      title: "A bulk crystal from a prototype (fcc, bcc, rocksalt, …) and a lattice constant",
      onSelect: () => a.addBuiltin("crystal"),
    },
    {
      label: "Polymer chain",
      testId: "builder-flow-add-polymer",
      title: "A linear polymer from a repeat unit (PE, PS, PMMA, … or your own SMILES)",
      onSelect: () => a.addBuiltin("polymer"),
    },
    { separator: true },
    { caption: "Crystal" },
    {
      label: "Supercell",
      testId: "builder-flow-add-supercell",
      title: "Repeat a structure with a cell along a, b and c",
      onSelect: () => a.addBuiltin("supercell"),
    },
    {
      label: "Slab",
      testId: "builder-flow-add-slab",
      title: "Cut a (h k l) surface slab with vacuum from a bulk crystal",
      onSelect: () => a.addBuiltin("slab"),
    },
    {
      label: "Place on surface",
      testId: "builder-flow-add-adsorb",
      title: "Lay copies of a molecule on a grid above a slab",
      onSelect: () => a.addBuiltin("adsorb"),
    },
  ];
  if (a.tools) {
    items.push({ separator: true }, { caption: "Tools" });
    items.push(...toolsMenuItems({ ...a.tools, openForm: a.addTool }, a.openServer));
  }
  return items;
}

/** The menu row of a template: its name over a one-line description. */
function TemplateLabel({ label, description }: { label: string; description: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 1, whiteSpace: "normal" }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 10.5, color: "var(--megane-text-muted)", maxWidth: 240 }}>
        {description}
      </span>
    </span>
  );
}

/**
 * The Templates menu: each ready-made flow, saying when it needs a tool
 * server. On a host without tool servers (`hasTools` false) the ones that
 * need one are left out: they could never run there.
 */
export function templateMenuItems(
  apply: (templateId: string) => void,
  hasTools = true,
): MenuItem[] {
  return FLOW_TEMPLATES.filter((t) => hasTools || t.tools.length === 0).map((t) => ({
    label: (
      <TemplateLabel
        label={t.label}
        description={t.tools.length > 0 ? `${t.description} Needs a tool server.` : t.description}
      />
    ),
    testId: `builder-flow-template-${t.id}`,
    onSelect: () => apply(t.id),
  }));
}

export interface FlowFileMenuActions {
  open: () => void;
  save: () => void;
  clear: () => void;
  /** Whether there are blocks to save or clear. */
  hasBlocks: boolean;
}

export function flowFileMenuItems(a: FlowFileMenuActions): MenuItem[] {
  return [
    { label: "Open flow…", testId: "builder-flow-open", onSelect: a.open },
    {
      label: "Save flow",
      testId: "builder-flow-save",
      title: "Save the blocks and wires as a .megane-flow.json file",
      disabled: !a.hasBlocks,
      onSelect: a.save,
    },
    { separator: true },
    {
      label: "Clear all blocks",
      testId: "builder-flow-clear",
      disabled: !a.hasBlocks,
      onSelect: a.clear,
    },
  ];
}

/** What the rail does that is not about adding blocks: files and runs. */
export interface FlowActions {
  /** A flow file the user picked with Open flow…. */
  onOpenFile: (file: File) => void;
  onSave: () => void;
  onClear: () => void;
  hasBlocks: boolean;
  running: boolean;
  /** Stop was pressed and the run is ending. */
  stopping?: boolean;
  onRun: () => void;
  onStop: () => void;
}

/** Undo and Redo of the graph's changes. */
export interface FlowHistoryActions {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export interface FlowRailProps extends FlowActions, Partial<FlowHistoryActions> {
  addItems: MenuItem[];
  /** Replace the flow with a template. */
  onApplyTemplate: (templateId: string) => void;
  onAutoLayout: () => void;
  /** The host reaches tool servers: templates that need one are listed. Default true. */
  hasTools?: boolean;
}

/** "⌘" on a Mac, "Ctrl" elsewhere, for the shortcuts in tooltips. */
function modKey(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘"
    : "Ctrl";
}

export function FlowRail({
  addItems,
  onApplyTemplate,
  onAutoLayout,
  onOpenFile,
  onSave,
  onClear,
  hasBlocks,
  running,
  stopping = false,
  onRun,
  onStop,
  hasTools = true,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: FlowRailProps) {
  const mod = modKey();
  const inputRef = useRef<HTMLInputElement>(null);
  const fileItems = flowFileMenuItems({
    open: () => inputRef.current?.click(),
    save: onSave,
    clear: onClear,
    hasBlocks,
  });
  return (
    <PanelRail testId="builder-flow-rail" label="Flow">
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        data-testid="builder-flow-open-input"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onOpenFile(file);
        }}
      />
      <RailMenu
        testId="builder-flow-add"
        label="Add"
        title="Add a block"
        icon={IconAdd}
        items={addItems}
      />
      <RailMenu
        testId="builder-flow-templates"
        label="Templates"
        title="Templates: replace the flow with a ready-made one"
        icon={IconTemplates}
        items={templateMenuItems(onApplyTemplate, hasTools)}
      />
      <RailButton
        testId="builder-flow-layout"
        label="Auto Layout"
        title="Auto Layout: arrange the blocks in rows, each below the blocks it takes inputs from"
        icon={IconLayout}
        onClick={onAutoLayout}
        disabled={!hasBlocks}
      />
      {onUndo && onRedo && (
        <>
          <RailDivider />
          <RailButton
            testId="builder-flow-undo"
            label="Undo"
            title={`Undo the last change to the flow (${mod}+Z)`}
            icon={IconUndo}
            onClick={onUndo}
            disabled={!canUndo || running}
          />
          <RailButton
            testId="builder-flow-redo"
            label="Redo"
            title={`Redo (${mod}+Shift+Z)`}
            icon={IconRedo}
            onClick={onRedo}
            disabled={!canRedo || running}
          />
        </>
      )}
      <RailDivider />
      {running ? (
        <RailButton
          testId="builder-flow-stop"
          label={stopping ? "Stopping…" : "Stop"}
          title={
            stopping
              ? "Stopping…: waiting for the block in progress to let go"
              : "Stop the run (a tool call or an RDKit embedding in progress is abandoned)"
          }
          icon={IconStop}
          onClick={onStop}
          disabled={stopping}
          active
        />
      ) : (
        <RailButton
          testId="builder-flow-run"
          label="Run"
          title="Run: build every block whose settings or inputs changed, then make the output block's result the Manual structure (it replaces the open structure and its undo history; unsaved edits are asked about first)"
          icon={IconRun}
          onClick={onRun}
          disabled={!hasBlocks}
        />
      )}
      <RailDivider />
      <RailMenu
        testId="builder-flow-file"
        label="File"
        title="File: open, save or clear the flow"
        icon={IconFile}
        items={fileItems}
      />
      <RailSpacer />
      <ThemeCycleButton
        testId="builder-flow-theme"
        style={railButtonStyle(false)}
        iconOnly
        iconSize={18}
      />
    </PanelRail>
  );
}
