/**
 * The Flow panel's rail: a column of icon buttons down the panel's left edge,
 * built from the same pieces as the viewer's Pipeline rail
 * (`components/graph/PanelRail`). Top to bottom:
 *
 *   Add, Layout   — build the graph
 *   Run / Stop    — build every block (or stop the run)
 *   File          — open / save the flow as JSON, clear it
 *   Theme         — at the foot, as in the viewer
 *
 * The menus are pure item lists (`addMenuItems`, `flowFileMenuItems`) so the
 * rail and its tests read the same thing.
 */

import { useRef } from "react";
import type { MenuItem } from "../Menu";
import { ThemeCycleButton } from "../../components/ThemeCycleButton";
import { PanelRail, RailButton, RailMenu, RailSpacer } from "../../components/graph/PanelRail";
import { RailDivider, RailIcon, railButtonStyle } from "../rail";
import type { BuilderToolInfo } from "../tools/contract";
import { toolsMenuItems } from "../tools/ToolServer";
import type { ToolsStore } from "../tools/store";

const IconAdd = (
  <RailIcon>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 8v8M8 12h8" />
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

const IconStop = (
  <RailIcon>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </RailIcon>
);

export interface AddMenuActions {
  addSmiles: () => void;
  addLibrary: () => void;
  addDocument: () => void;
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
  ];
  if (a.tools) {
    items.push({ separator: true }, { caption: "Tools" });
    items.push(...toolsMenuItems({ ...a.tools, openForm: a.addTool }, a.openServer));
  }
  return items;
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
  onRun: () => void;
  onStop: () => void;
}

export interface FlowRailProps extends FlowActions {
  addItems: MenuItem[];
  onAutoLayout: () => void;
}

export function FlowRail({
  addItems,
  onAutoLayout,
  onOpenFile,
  onSave,
  onClear,
  hasBlocks,
  running,
  onRun,
  onStop,
}: FlowRailProps) {
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
      <RailButton
        testId="builder-flow-layout"
        label="Auto Layout"
        title="Auto Layout"
        icon={IconLayout}
        onClick={onAutoLayout}
        disabled={!hasBlocks}
      />
      <RailDivider />
      {running ? (
        <RailButton
          testId="builder-flow-stop"
          label="Stop"
          title="Stop the run (a tool call in progress is abandoned)"
          icon={IconStop}
          onClick={onStop}
          active
        />
      ) : (
        <RailButton
          testId="builder-flow-run"
          label="Run"
          title="Run: build every block whose settings or inputs changed"
          icon={IconRun}
          onClick={onRun}
          disabled={!hasBlocks}
        />
      )}
      <RailDivider />
      <RailMenu
        testId="builder-flow-file"
        label="Flow"
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
