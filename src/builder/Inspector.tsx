/**
 * The top of the sidebar: what you are looking at. With nothing selected it
 * describes the structure (formula, atoms, bonds, mass, and each element as a
 * chip that selects all its atoms); with a selection it describes the
 * selected atoms — each atom and its position, the distance, angle or
 * dihedral they span (2, 3 or 4 atoms, in the order they were picked) — and
 * offers what can be done with them.
 */

import { useMemo } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "./store";
import { buttonStyle, hintStyle, inputStyle, rowStyle, sectionStyle } from "./styles";
import { getAtomicMass, getElementSymbol } from "../constants";
import { computeMeasurement } from "../renderer/Selection";
import { formulaOf } from "./library/fragment";
import { useLibraryActions } from "./library/ui";
import { QUICK_ELEMENTS } from "./ContextBar";
import type { EditAtomRef } from "../pipeline/types";
import type { Snapshot } from "../types";

/** Selected atoms listed one per row; the rest are counted. */
export const MAX_ATOM_ROWS = 6;

const MEASURE_LABELS = { distance: "Distance", angle: "Angle", dihedral: "Dihedral" } as const;

const titleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--megane-text-secondary, #64748b)",
};

const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** Atom indices of each element, in Hill order (C, H, then alphabetical). */
export function elementGroups(elements: ArrayLike<number>): { z: number; atoms: number[] }[] {
  const byZ = new Map<number, number[]>();
  for (let i = 0; i < elements.length; i++) {
    const list = byZ.get(elements[i]) ?? [];
    list.push(i);
    byZ.set(elements[i], list);
  }
  const sym = (z: number) => getElementSymbol(z);
  const rank = (z: number) => (z === 6 ? 0 : z === 1 && byZ.has(6) ? 1 : 2);
  return [...byZ.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || sym(a).localeCompare(sym(b)))
    .map(([z, atoms]) => ({ z, atoms }));
}

export function Inspector() {
  const hasSelection = useBuilderStore((s) => s.selected.length > 0);
  return hasSelection ? <SelectionInspector /> : <StructureInspector />;
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid var(--megane-border-solid, #e2e8f0)",
        background: "var(--megane-bg, #fff)",
      }}
    >
      <div style={{ ...hintStyle, fontSize: 11 }}>{label}</div>
      <div style={{ ...monoStyle, fontSize: 14 }} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function StructureInspector() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const setSelected = useBuilderStore((s) => s.setSelected);
  const shown = shownSnapshot({ source, result, showOriginal });

  const summary = useMemo(() => {
    if (!shown) return null;
    let mass = 0;
    for (let i = 0; i < shown.nAtoms; i++) mass += getAtomicMass(shown.elements[i]);
    return {
      formula: formulaOf(shown.elements),
      mass,
      groups: elementGroups(shown.elements),
    };
  }, [shown]);

  if (!shown || !summary) return null;

  return (
    <div style={sectionStyle} data-testid="builder-inspector-structure">
      <div style={{ ...rowStyle, justifyContent: "space-between" }}>
        <span style={titleStyle}>Structure</span>
        <span style={hintStyle}>nothing selected</span>
      </div>
      <div
        data-testid="builder-inspector-formula"
        style={{ ...monoStyle, fontSize: 18, wordBreak: "break-all" }}
      >
        {summary.formula || "—"}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Stat label="Atoms" value={String(shown.nAtoms)} testId="builder-inspector-atoms" />
        <Stat label="Bonds" value={String(shown.nBonds)} testId="builder-inspector-bonds" />
        <Stat
          label="Mass (g/mol)"
          value={summary.mass.toFixed(2)}
          testId="builder-inspector-mass"
        />
      </div>
      {summary.groups.length > 0 && (
        <>
          <span style={hintStyle}>Elements — click to select all</span>
          <div style={rowStyle}>
            {summary.groups.map(({ z, atoms }) => (
              <button
                key={z}
                type="button"
                data-testid={`builder-inspector-element-${getElementSymbol(z)}`}
                style={{ ...buttonStyle(), display: "inline-flex", gap: 6 }}
                onClick={() => setSelected(atoms)}
                title={`Select every ${getElementSymbol(z)} atom`}
              >
                {getElementSymbol(z)}
                <span style={{ ...monoStyle, color: "var(--megane-text-secondary, #64748b)" }}>
                  {atoms.length}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function position(shown: Snapshot, i: number): string {
  const p = shown.positions;
  return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]].map((v) => v.toFixed(3)).join("  ");
}

function SelectionInspector() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const selected = useBuilderStore((s) => s.selected);
  const element = useBuilderStore((s) => s.element);
  const setElement = useBuilderStore((s) => s.setElement);
  const clearSelected = useBuilderStore((s) => s.clearSelected);
  const pushOp = useBuilderStore((s) => s.pushOp);
  const { saveSelection } = useLibraryActions();

  const shown = shownSnapshot({ source, result, showOriginal });
  const editable = canEdit({ source, result, showOriginal });
  const atoms = shown ? selected.filter((i) => i >= 0 && i < shown.nAtoms) : [];
  const measure =
    shown && atoms.length >= 2 && atoms.length <= 4
      ? computeMeasurement(shown.positions, atoms)
      : null;
  const elementChoices = QUICK_ELEMENTS.includes(element)
    ? QUICK_ELEMENTS
    : [...QUICK_ELEMENTS, element];

  const refs = (): EditAtomRef[] =>
    atoms.map((i) => result!.refAt(i)).filter((r): r is EditAtomRef => r !== null);

  const handleDelete = () => {
    const r = refs();
    if (r.length === 0) return;
    clearSelected();
    pushOp({ op: "delete_atoms", atoms: r });
  };
  const handleSetElement = () => {
    const r = refs();
    if (r.length === 0) return;
    pushOp({ op: "set_element", atoms: r, element });
  };

  return (
    <div
      style={{ ...sectionStyle, borderColor: "rgba(37, 99, 235, 0.35)" }}
      data-testid="builder-selection"
    >
      <div style={{ ...rowStyle, justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span style={{ ...titleStyle, color: "#1d4ed8" }} data-testid="builder-selected-count">
          {selected.length} atom{selected.length === 1 ? "" : "s"} selected
        </span>
        <button
          type="button"
          data-testid="builder-clear-selection"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          style={{ ...buttonStyle(), padding: "2px 8px" }}
          onClick={clearSelected}
        >
          ×
        </button>
      </div>

      {shown && atoms.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRadius: 6,
            border: "1px solid var(--megane-border-solid, #e2e8f0)",
            background: "var(--megane-bg, #fff)",
          }}
        >
          {atoms.slice(0, MAX_ATOM_ROWS).map((i, k) => (
            <div
              key={i}
              data-testid={`builder-inspector-atom-${k}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                borderTop: k > 0 ? "1px solid var(--megane-border-solid, #eef2f7)" : undefined,
                fontSize: 12,
              }}
            >
              <b style={{ width: 22 }}>{getElementSymbol(shown.elements[i])}</b>
              <span style={{ ...monoStyle, ...hintStyle, width: 44 }}>#{i}</span>
              <span style={{ ...monoStyle, flex: 1, textAlign: "right", whiteSpace: "pre" }}>
                {position(shown, i)}
              </span>
            </div>
          ))}
          {atoms.length > MAX_ATOM_ROWS && (
            <div
              data-testid="builder-inspector-more"
              style={{ ...hintStyle, padding: "4px 8px", fontSize: 11 }}
            >
              and {atoms.length - MAX_ATOM_ROWS} more
            </div>
          )}
        </div>
      )}

      {measure ? (
        <div data-testid="builder-inspector-measure" data-type={measure.type}>
          <div style={hintStyle}>{MEASURE_LABELS[measure.type]}</div>
          <div style={{ ...monoStyle, fontSize: 22 }}>{measure.label}</div>
        </div>
      ) : (
        atoms.length === 1 && (
          <div style={hintStyle} data-testid="builder-inspector-measure-hint">
            Shift-click 1–3 more atoms for a distance, angle or dihedral.
          </div>
        )
      )}

      <div style={{ ...rowStyle, flexWrap: "nowrap" }}>
        <span style={{ ...hintStyle, flex: 1 }}>Change element to</span>
        <select
          data-testid="builder-selection-element"
          aria-label="Element"
          value={element}
          onChange={(e) => setElement(Number(e.target.value))}
          style={inputStyle}
        >
          {elementChoices.map((z) => (
            <option key={z} value={z}>
              {getElementSymbol(z)}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="builder-set-element-selected"
          style={buttonStyle("default", !editable)}
          disabled={!editable}
          onClick={handleSetElement}
        >
          Set to {getElementSymbol(element)}
        </button>
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-library-save-selection"
          style={buttonStyle("default", !shown)}
          disabled={!shown}
          onClick={saveSelection}
          title="Keep the selected atoms (and the bonds between them) as a library molecule"
        >
          Save as fragment
        </button>
        <button
          type="button"
          data-testid="builder-delete-selected"
          style={buttonStyle("danger", !editable)}
          disabled={!editable}
          onClick={handleDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
