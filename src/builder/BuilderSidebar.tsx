/**
 * The Builder's side panel, in four layers:
 *
 *   Tool      — the tool, and *only* the settings that tool uses
 *   Library   — molecules to drop into the document
 *   Crystal   — cell, supercell, slab, symmetry (edits of the open structure)
 *   History   — the operation list, undo / redo / clear, "show original"
 *
 * Document-level actions (open, new, save) live in the top bar, not here, so
 * each control appears exactly once. Pure UI over `useBuilderStore`; every
 * edit goes through the store's actions and the handlers installed by
 * `useBuilderHandlers`.
 */

import { useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "./store";
import { describeOp } from "./placement";
import { Section } from "./Section";
import { TOOL_KEYS } from "./shortcuts";
import type { BuildTool } from "./types";
import type { EditAtomRef } from "../pipeline/types";
import { getElementSymbol } from "../constants";
import { LibrarySection, DEFAULT_ADSORB_HEIGHT } from "./library/LibrarySection";
import { CrystalSection } from "./crystal/CrystalSection";
import {
  buttonStyle,
  chipStyle,
  hintStyle,
  inputStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  segmentGroupStyle,
  segmentStyle,
  toggleStyle,
} from "./styles";

export {
  sectionStyle,
  sectionTitleStyle,
  hintStyle,
  inputStyle,
  chipStyle,
  buttonStyle,
} from "./styles";

export interface ToolInfo {
  value: BuildTool;
  label: string;
  hint: string;
  /** Which contextual settings the tool panel shows for it. */
  needs: ("element" | "bondOrder" | "place")[];
}

export const TOOLS: ToolInfo[] = [
  {
    value: "select",
    label: "Select",
    hint: "Click atoms to select them (Shift adds).",
    needs: [],
  },
  {
    value: "add",
    label: "Add atom",
    hint: "Click an atom to attach a new one at bond length; click empty space to place it free.",
    needs: ["element", "bondOrder"],
  },
  {
    value: "bond",
    label: "Bond",
    hint: "Click two atoms to bond them (or change the bond order).",
    needs: ["bondOrder"],
  },
  {
    value: "delete",
    label: "Delete",
    hint: "Click an atom to remove it with its bonds.",
    needs: [],
  },
  { value: "move", label: "Move", hint: "Drag an atom in the screen plane.", needs: [] },
  {
    value: "element",
    label: "Element",
    hint: "Click an atom to change it to the chosen element.",
    needs: ["element"],
  },
  {
    value: "place",
    label: "Place",
    hint: "Click empty space to drop the library molecule chosen below there.",
    needs: ["place"],
  },
];

/** Elements offered as quick chips; anything else via the number input. */
const QUICK_ELEMENTS = [1, 6, 7, 8, 9, 15, 16, 17, 35, 14];

const BOND_ORDERS: { value: number; label: string }[] = [
  { value: 1, label: "Single" },
  { value: 2, label: "Double" },
  { value: 3, label: "Triple" },
  { value: 4, label: "Aromatic" },
];

export function BuilderSidebar() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const setShowOriginal = useBuilderStore((s) => s.setShowOriginal);

  const editable = canEdit({ source, result, showOriginal });

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
          Open a structure file, or start a new one from the top bar.
        </div>
      )}
      {source && showOriginal && (
        <div
          data-testid="builder-paused"
          style={{
            ...sectionStyle,
            gap: 6,
            background: "rgba(245, 158, 11, 0.12)",
            color: "#92400e",
            fontSize: 12,
          }}
        >
          <span>Showing the structure as loaded. Editing is paused.</span>
          <div>
            <button
              type="button"
              data-testid="builder-resume-editing"
              style={buttonStyle()}
              onClick={() => setShowOriginal(false)}
            >
              Back to the edited structure
            </button>
          </div>
        </div>
      )}

      <ToolPanel editable={editable} />
      <LibrarySection />
      <CrystalSection />
      <HistorySection defaultOpen={edits.length > 0} />
    </div>
  );
}

// ── Tool ──

function ToolPanel({ editable }: { editable: boolean }) {
  const tool = useBuilderStore((s) => s.tool);
  const element = useBuilderStore((s) => s.element);
  const bondOrder = useBuilderStore((s) => s.bondOrder);
  const selected = useBuilderStore((s) => s.selected);
  const pendingBondAtom = useBuilderStore((s) => s.pendingBondAtom);
  const placeSource = useBuilderStore((s) => s.placeSource);
  const adsorbHeight = useBuilderStore((s) => s.adsorbHeight);
  const setTool = useBuilderStore((s) => s.setTool);
  const setElement = useBuilderStore((s) => s.setElement);
  const setBondOrder = useBuilderStore((s) => s.setBondOrder);
  const setAdsorbHeight = useBuilderStore((s) => s.setAdsorbHeight);

  const active = TOOLS.find((t) => t.value === tool)!;

  return (
    <div style={sectionStyle} data-testid="builder-tools">
      <span style={sectionTitleStyle}>Tool</span>
      <div style={segmentGroupStyle} role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <span
            key={t.value}
            role="radio"
            data-testid={`builder-tool-${t.value}`}
            aria-checked={tool === t.value}
            aria-pressed={tool === t.value}
            title={`${t.label} (${TOOL_KEYS[t.value]})`}
            style={segmentStyle(tool === t.value)}
            onClick={() => setTool(t.value)}
          >
            {t.label}
          </span>
        ))}
      </div>
      <div style={hintStyle} data-testid="builder-tool-hint">
        {active.hint}
        {tool === "bond" && pendingBondAtom !== null && ` First atom: #${pendingBondAtom}.`}
        {tool === "place" &&
          (placeSource ? ` Placing ${placeSource.name}.` : " Choose a molecule in the library.")}
      </div>

      {active.needs.includes("element") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={hintStyle}>Element</span>
          <div style={rowStyle}>
            {QUICK_ELEMENTS.map((z) => (
              <span
                key={z}
                role="button"
                data-testid={`builder-element-${getElementSymbol(z)}`}
                aria-pressed={element === z}
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
        </div>
      )}

      {active.needs.includes("bondOrder") && (
        <label style={rowStyle}>
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
        </label>
      )}

      {active.needs.includes("place") && (
        <AdsorbOption height={adsorbHeight} onChange={setAdsorbHeight} />
      )}

      {selected.length > 0 && <SelectionActions editable={editable} />}
    </div>
  );
}

/**
 * "Place on atoms": with a height set, the Place tool also accepts a click on
 * an atom and stamps the molecule that far above it — an adsorbate on a site.
 */
function AdsorbOption({
  height,
  onChange,
}: {
  height: number | null;
  onChange: (h: number | null) => void;
}) {
  // The typed height survives unticking the box, so turning the option back
  // on uses it again rather than the default.
  const [draft, setDraft] = useState(height ?? DEFAULT_ADSORB_HEIGHT);
  return (
    <label style={{ ...rowStyle, ...hintStyle }}>
      <input
        type="checkbox"
        data-testid="builder-adsorb-toggle"
        checked={height !== null}
        onChange={(e) => onChange(e.target.checked ? draft : null)}
      />
      Place on atoms:
      <input
        type="number"
        data-testid="builder-adsorb-height"
        step={0.1}
        value={draft}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraft(v);
          if (height !== null) onChange(v);
        }}
        style={{ ...inputStyle, width: 56 }}
        title="Height above the clicked atom along the cell's c axis (an adsorbate on a surface site)"
      />
      Å above along c
    </label>
  );
}

/** What can be done with the current selection, shown only while there is one. */
function SelectionActions({ editable }: { editable: boolean }) {
  const result = useBuilderStore((s) => s.result);
  const selected = useBuilderStore((s) => s.selected);
  const element = useBuilderStore((s) => s.element);
  const clearSelected = useBuilderStore((s) => s.clearSelected);
  const pushOp = useBuilderStore((s) => s.pushOp);

  const refs = (): EditAtomRef[] =>
    selected
      .map((i) => (result && i >= 0 && i < result.snapshot.nAtoms ? result.refAt(i) : null))
      .filter((r): r is EditAtomRef => r !== null);

  const handleDelete = () => {
    const atoms = refs();
    if (atoms.length === 0) return;
    clearSelected();
    pushOp({ op: "delete_atoms", atoms });
  };
  const handleSetElement = () => {
    const atoms = refs();
    if (atoms.length === 0) return;
    pushOp({ op: "set_element", atoms, element });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        paddingTop: 8,
        borderTop: "1px solid var(--megane-border-solid, #e2e8f0)",
      }}
      data-testid="builder-selection"
    >
      <span style={hintStyle} data-testid="builder-selected-count">
        {selected.length} atom{selected.length === 1 ? "" : "s"} selected.
      </span>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-delete-selected"
          style={buttonStyle("danger", !editable)}
          disabled={!editable}
          onClick={handleDelete}
        >
          Delete
        </button>
        <button
          type="button"
          data-testid="builder-set-element-selected"
          style={buttonStyle("default", !editable)}
          disabled={!editable}
          onClick={handleSetElement}
        >
          Set to {getElementSymbol(element)}
        </button>
        <button
          type="button"
          data-testid="builder-clear-selection"
          style={buttonStyle()}
          onClick={clearSelected}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ── History ──

function HistorySection({ defaultOpen }: { defaultOpen: boolean }) {
  const source = useBuilderStore((s) => s.source);
  const edits = useBuilderStore((s) => s.edits);
  const redoStack = useBuilderStore((s) => s.redoStack);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const clearOps = useBuilderStore((s) => s.clearOps);
  const setShowOriginal = useBuilderStore((s) => s.setShowOriginal);

  return (
    <Section
      id="history"
      title="History"
      defaultOpen={defaultOpen}
      summary={
        <span data-testid="builder-op-count">
          {edits.length} edit{edits.length === 1 ? "" : "s"}
        </span>
      }
    >
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-undo"
          style={buttonStyle("default", edits.length === 0)}
          disabled={edits.length === 0}
          onClick={() => undo()}
        >
          Undo
        </button>
        <button
          type="button"
          data-testid="builder-redo"
          style={buttonStyle("default", redoStack.length === 0)}
          disabled={redoStack.length === 0}
          onClick={() => redo()}
        >
          Redo
        </button>
        <button
          type="button"
          data-testid="builder-clear-ops"
          style={buttonStyle("danger", edits.length === 0)}
          disabled={edits.length === 0}
          onClick={clearOps}
        >
          Clear all
        </button>
        <span
          role="button"
          data-testid="builder-show-original"
          aria-pressed={showOriginal}
          style={toggleStyle(showOriginal, !source || (edits.length === 0 && !showOriginal))}
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
    </Section>
  );
}
