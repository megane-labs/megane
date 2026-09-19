/**
 * The Builder's side panel: tool, element, selection, cell, history, export.
 * Pure UI over `useBuilderStore`; every edit goes through the store's actions
 * and the handlers installed by `useBuilderHandlers`.
 */

import { useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "./store";
import { describeOp } from "./placement";
import type { BuildTool } from "./types";
import type { EditAtomRef } from "../pipeline/types";
import { getElementSymbol } from "../constants";
import { STRUCTURE_EXPORT_FORMATS, exportSnapshot } from "../export/structureExport";
import type { StructureWriteFormat } from "../parsers/parseCore";

export const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid, #e2e8f0)",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--megane-surface-solid, #fff)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--megane-text-secondary, #64748b)",
};

export const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--megane-text-secondary, #64748b)",
};

export const inputStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--megane-text, #334155)",
  background: "var(--megane-surface-solid, #f1f5f9)",
  border: "1px solid var(--megane-border-solid, #cbd5e1)",
  borderRadius: 4,
  padding: "3px 6px",
};

export function chipStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: disabled ? "default" : "pointer",
    border: active ? "1px solid #2563eb" : "1px solid var(--megane-border-solid, #cbd5e1)",
    background: active ? "#2563eb" : "var(--megane-surface-solid, #f1f5f9)",
    color: active ? "#fff" : disabled ? "#94a3b8" : "var(--megane-text, #334155)",
    userSelect: "none",
    opacity: disabled ? 0.6 : 1,
  };
}

const TOOLS: { value: BuildTool; label: string; hint: string }[] = [
  { value: "select", label: "Select", hint: "Click atoms to select them (Shift adds)." },
  {
    value: "add",
    label: "Add atom",
    hint: "Click an atom to attach a new one at bond length; click empty space to place it free.",
  },
  {
    value: "bond",
    label: "Bond",
    hint: "Click two atoms to bond them (or change the bond order).",
  },
  { value: "delete", label: "Delete", hint: "Click an atom to remove it with its bonds." },
  { value: "move", label: "Move", hint: "Drag an atom in the screen plane." },
  { value: "element", label: "Element", hint: "Click an atom to change it to the chosen element." },
];

/** Elements offered as quick chips; anything else via the number input. */
const QUICK_ELEMENTS = [1, 6, 7, 8, 9, 15, 16, 17, 35, 14];

const BOND_ORDERS: { value: number; label: string }[] = [
  { value: 1, label: "Single" },
  { value: 2, label: "Double" },
  { value: 3, label: "Triple" },
  { value: 4, label: "Aromatic" },
];

/** Default edge of a new cell, in Å. */
export const DEFAULT_NEW_CELL_EDGE = 10;

export function BuilderSidebar() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const redoStack = useBuilderStore((s) => s.redoStack);
  const fileName = useBuilderStore((s) => s.fileName);
  const sourceLabels = useBuilderStore((s) => s.sourceLabels);
  const tool = useBuilderStore((s) => s.tool);
  const element = useBuilderStore((s) => s.element);
  const bondOrder = useBuilderStore((s) => s.bondOrder);
  const selected = useBuilderStore((s) => s.selected);
  const pendingBondAtom = useBuilderStore((s) => s.pendingBondAtom);
  const setTool = useBuilderStore((s) => s.setTool);
  const setElement = useBuilderStore((s) => s.setElement);
  const setBondOrder = useBuilderStore((s) => s.setBondOrder);
  const clearSelected = useBuilderStore((s) => s.clearSelected);
  const pushOp = useBuilderStore((s) => s.pushOp);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const clearOps = useBuilderStore((s) => s.clearOps);
  const setShowOriginal = useBuilderStore((s) => s.setShowOriginal);
  const newCell = useBuilderStore((s) => s.newCell);

  const editable = canEdit({ source, result, showOriginal });
  const shown = shownSnapshot({ source, result, showOriginal });
  const refFor = (i: number): EditAtomRef | null => result?.outputRefs[i] ?? null;
  const activeTool = TOOLS.find((t) => t.value === tool)!;

  const handleDeleteSelected = () => {
    const refs = selected.map(refFor).filter((r): r is EditAtomRef => r !== null);
    if (refs.length === 0) return;
    clearSelected();
    pushOp({ op: "delete_atoms", atoms: refs });
  };
  const handleSetElementSelected = () => {
    const refs = selected.map(refFor).filter((r): r is EditAtomRef => r !== null);
    if (refs.length === 0) return;
    pushOp({ op: "set_element", atoms: refs, element });
  };
  const handleExport = async (format: StructureWriteFormat) => {
    if (!shown) return;
    await exportSnapshot(shown, format, fileName, sourceLabels);
  };

  return (
    <div
      data-testid="builder-sidebar"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        overflowY: "auto",
        fontSize: 13,
        color: "var(--megane-text, #1e293b)",
      }}
    >
      {!source && (
        <div style={hintStyle} data-testid="builder-empty-hint">
          Open a structure file or start from an empty cell.
        </div>
      )}
      {source && showOriginal && (
        <div
          data-testid="builder-paused"
          style={{
            ...sectionStyle,
            background: "rgba(245, 158, 11, 0.12)",
            color: "#92400e",
            fontSize: 12,
          }}
        >
          Showing the structure as loaded. Turn off &quot;Show original&quot; to continue editing.
        </div>
      )}

      <div style={sectionStyle}>
        <span style={sectionTitleStyle}>Tool</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TOOLS.map((t) => (
            <span
              key={t.value}
              role="button"
              data-testid={`builder-tool-${t.value}`}
              aria-pressed={tool === t.value}
              style={chipStyle(tool === t.value)}
              onClick={() => setTool(t.value)}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div style={hintStyle} data-testid="builder-tool-hint">
          {activeTool.hint}
          {tool === "bond" && pendingBondAtom !== null && ` First atom: #${pendingBondAtom}.`}
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={sectionTitleStyle}>Element</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {QUICK_ELEMENTS.map((z) => (
            <span
              key={z}
              role="button"
              data-testid={`builder-element-${getElementSymbol(z)}`}
              style={chipStyle(element === z)}
              onClick={() => setElement(z)}
            >
              {getElementSymbol(z)}
            </span>
          ))}
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}>
            Z
            <input
              data-testid="builder-element-z"
              type="number"
              min={1}
              max={118}
              value={element}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v) && v >= 1 && v <= 118) setElement(v);
              }}
              style={{ ...inputStyle, width: 56 }}
            />
          </label>
          <span style={hintStyle}>= {getElementSymbol(element)}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={hintStyle}>Bond order</span>
          <select
            data-testid="builder-bond-order"
            value={bondOrder}
            onChange={(e) => setBondOrder(parseInt(e.target.value, 10))}
            style={inputStyle}
          >
            {BOND_ORDERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={sectionTitleStyle}>Selection</span>
        <div style={hintStyle} data-testid="builder-selected-count">
          {selected.length === 0
            ? "No atoms selected."
            : `${selected.length} atom${selected.length === 1 ? "" : "s"} selected.`}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span
            role="button"
            data-testid="builder-delete-selected"
            style={chipStyle(false, selected.length === 0 || !editable)}
            onClick={selected.length > 0 && editable ? handleDeleteSelected : undefined}
          >
            Delete selected
          </span>
          <span
            role="button"
            data-testid="builder-set-element-selected"
            style={chipStyle(false, selected.length === 0 || !editable)}
            onClick={selected.length > 0 && editable ? handleSetElementSelected : undefined}
          >
            Set to {getElementSymbol(element)}
          </span>
          <span
            role="button"
            data-testid="builder-clear-selection"
            style={chipStyle(false, selected.length === 0)}
            onClick={selected.length > 0 ? clearSelected : undefined}
          >
            Clear
          </span>
        </div>
      </div>

      <NewCellSection onCreate={newCell} />

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={sectionTitleStyle}>History</span>
          <span style={hintStyle} data-testid="builder-op-count">
            {edits.length} edit{edits.length === 1 ? "" : "s"}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span
            role="button"
            data-testid="builder-undo"
            style={chipStyle(false, edits.length === 0)}
            onClick={edits.length > 0 ? () => undo() : undefined}
          >
            Undo
          </span>
          <span
            role="button"
            data-testid="builder-redo"
            style={chipStyle(false, redoStack.length === 0)}
            onClick={redoStack.length > 0 ? () => redo() : undefined}
          >
            Redo
          </span>
          <span
            role="button"
            data-testid="builder-clear-ops"
            style={chipStyle(false, edits.length === 0)}
            onClick={edits.length > 0 ? clearOps : undefined}
          >
            Clear all
          </span>
          <span
            role="button"
            data-testid="builder-show-original"
            aria-pressed={showOriginal}
            style={chipStyle(showOriginal, !source || (edits.length === 0 && !showOriginal))}
            onClick={
              source && (edits.length > 0 || showOriginal)
                ? () => setShowOriginal(!showOriginal)
                : undefined
            }
            title="Preview the structure as loaded, without the edits"
          >
            Show original
          </span>
        </div>
        {edits.length > 0 && (
          <ol
            data-testid="builder-op-list"
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: "var(--megane-text-secondary, #475569)",
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {edits.map((op, i) => (
              <li key={i}>{describeOp(op)}</li>
            ))}
          </ol>
        )}
        {result && result.warnings.length > 0 && (
          <div data-testid="builder-warnings" style={{ ...hintStyle, color: "#b45309" }}>
            {result.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <span style={sectionTitleStyle}>Export</span>
        <div style={hintStyle} data-testid="builder-export-summary">
          {shown
            ? `${shown.nAtoms} atoms, ${shown.nBonds} bonds as shown.`
            : "Nothing to save yet."}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {STRUCTURE_EXPORT_FORMATS.map((f) => (
            <span
              key={f.value}
              role="button"
              data-testid={`builder-export-${f.value}`}
              style={chipStyle(false, !shown)}
              onClick={shown ? () => void handleExport(f.value) : undefined}
            >
              Save {f.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * "New empty cell": start a document from an empty cubic cell to build into.
 * Replaces whatever is open.
 */
function NewCellSection({ onCreate }: { onCreate: (edge: number) => void }) {
  const [edge, setEdge] = useState(DEFAULT_NEW_CELL_EDGE);
  const valid = Number.isFinite(edge) && edge > 0;
  return (
    <div style={sectionStyle}>
      <span style={sectionTitleStyle}>New</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          Cubic cell
          <input
            type="number"
            min={0.1}
            step={1}
            value={edge}
            data-testid="builder-new-cell-edge"
            onChange={(e) => setEdge(Number(e.target.value))}
            style={{ ...inputStyle, width: 64 }}
          />
          Å
        </label>
        <span
          role="button"
          data-testid="builder-new-cell"
          style={chipStyle(false, !valid)}
          onClick={valid ? () => onCreate(edge) : undefined}
          title="Start from an empty cell (replaces the open structure)"
        >
          New empty cell
        </span>
      </div>
    </div>
  );
}
