/**
 * The selection, in the Details panel: the selected atoms — each atom and its position, the distance, angle or
 * dihedral they span (2, 3 or 4 atoms, in the order they were picked), which
 * can be typed in to move the last atom's side, a Transform form that moves
 * or turns them by numbers — and offers what can be done with them.
 */

import { useEffect, useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "./store";
import { buttonStyle, hintStyle, inputStyle, monoStyle, rowStyle, sectionStyle } from "./styles";
import { getElementSymbol } from "../constants";
import { computeMeasurement } from "../renderer/Selection";
import { useLibraryActions } from "./library/ui";
import { QUICK_ELEMENTS } from "./ContextBar";
import type { EditAtomRef } from "../pipeline/types";
import type { Measurement, Snapshot } from "../types";
import { setAngle, setDihedral, setDistance } from "./geometry";
import { runCleanup } from "./cleanup";
import {
  AXIS_KEYS,
  axisVector,
  rotateDisplacements,
  translateDisplacements,
  type AxisKey,
} from "./manipulate";

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

/**
 * The selected atoms, in the Details panel. With nothing selected it shows
 * nothing: the structure's own summary is the info line over the view.
 */
export function Inspector() {
  const hasSelection = useBuilderStore((s) => s.selected.length > 0);
  return hasSelection ? <SelectionInspector /> : null;
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
      style={{ ...sectionStyle, borderColor: "rgba(59, 130, 246, 0.35)" }}
      data-testid="builder-selection"
    >
      <div style={{ ...rowStyle, justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span
          style={{ ...titleStyle, color: "var(--megane-primary-text, #2563eb)" }}
          data-testid="builder-selected-count"
        >
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

      {measure && shown ? (
        <MeasureEditor measure={measure} shown={shown} editable={editable} />
      ) : (
        atoms.length === 1 && (
          <div style={hintStyle} data-testid="builder-inspector-measure-hint">
            Shift-click 1–3 more atoms for a distance, angle or dihedral.
          </div>
        )
      )}

      {shown && atoms.length > 0 && (
        <TransformEditor shown={shown} atoms={atoms} editable={editable} />
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
          data-testid="builder-selection-cleanup"
          style={buttonStyle("default", !editable)}
          disabled={!editable}
          onClick={() => void runCleanup(useBuilderStore)}
          title="Re-embed the selected molecules with RDKit (ETKDG + MMFF94s) and put them back in place"
        >
          Clean up
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

/**
 * The measurement of 2–4 selected atoms, with a field to set it: the last
 * picked atom's side of the structure moves (translated for a distance,
 * rotated for an angle or dihedral), as one Undo step.
 */
function MeasureEditor({
  measure,
  shown,
  editable,
}: {
  measure: Measurement;
  shown: Snapshot;
  editable: boolean;
}) {
  const moveAtoms = useBuilderStore((s) => s.moveAtoms);
  const reportError = useBuilderStore((s) => s.reportError);
  const unit = measure.type === "distance" ? "Å" : "°";
  const digits = measure.type === "distance" ? 3 : 1;
  const [draft, setDraft] = useState(measure.value.toFixed(digits));
  useEffect(() => setDraft(measure.value.toFixed(digits)), [measure.value, digits]);

  const apply = () => {
    // An empty field is no number (Number("") would read as 0).
    const target = draft.trim() === "" ? NaN : Number(draft);
    const [a, b, c, d] = measure.atoms;
    const moved =
      measure.type === "distance"
        ? setDistance(shown, a, b, target)
        : measure.type === "angle"
          ? setAngle(shown, a, b, c, target)
          : setDihedral(shown, a, b, c, d, target);
    if (!moved) {
      reportError(
        measure.type === "distance"
          ? "A distance must be a positive number of Å."
          : measure.type === "angle"
            ? "An angle must be between 0° and 180° (exclusive), and the atoms not in a line."
            : "The dihedral needs a number of degrees.",
      );
      return;
    }
    moveAtoms(moved);
  };

  return (
    <div data-testid="builder-inspector-measure" data-type={measure.type}>
      <div style={hintStyle}>{MEASURE_LABELS[measure.type]}</div>
      <div style={{ ...monoStyle, fontSize: 22 }}>{measure.label}</div>
      <form
        style={{ ...rowStyle, flexWrap: "nowrap", marginTop: 4 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (editable) apply();
        }}
      >
        <span style={{ ...hintStyle, flex: 1 }}>Set to</span>
        <input
          data-testid="builder-inspector-measure-input"
          aria-label={`${MEASURE_LABELS[measure.type]} in ${unit}`}
          type="number"
          step={measure.type === "distance" ? 0.01 : 1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ ...inputStyle, width: 80 }}
        />
        <span style={hintStyle}>{unit}</span>
        <button
          type="submit"
          data-testid="builder-inspector-measure-apply"
          style={buttonStyle("default", !editable)}
          disabled={!editable}
          title="Moves the last picked atom's side of the structure"
        >
          Set
        </button>
      </form>
    </div>
  );
}

/** A typed number, or NaN for an empty field (Number("") would read as 0). */
function parseField(text: string): number {
  return text.trim() === "" ? NaN : Number(text);
}

/**
 * Move the selection by a typed displacement, or turn it by a typed angle
 * about an axis (x / y / z, or the cell's a / b / c) through its centre. Each
 * is one Undo step.
 */
function TransformEditor({
  shown,
  atoms,
  editable,
}: {
  shown: Snapshot;
  atoms: number[];
  editable: boolean;
}) {
  const moveAtoms = useBuilderStore((s) => s.moveAtoms);
  const reportError = useBuilderStore((s) => s.reportError);
  const [delta, setDelta] = useState(["0", "0", "0"]);
  const [angle, setAngleText] = useState("90");
  const [axis, setAxis] = useState<AxisKey>("z");
  const axes = AXIS_KEYS.filter((k) => axisVector(k, shown.box) !== null);

  const move = () => {
    const d = delta.map(parseField) as [number, number, number];
    if (!d.every(Number.isFinite)) {
      reportError("Move by needs three numbers of Å.");
      return;
    }
    moveAtoms(translateDisplacements(atoms, d));
  };
  const rotate = () => {
    const deg = parseField(angle);
    const vector = axisVector(axis, shown.box);
    if (!Number.isFinite(deg) || !vector) {
      reportError("Rotate needs a number of degrees.");
      return;
    }
    moveAtoms(rotateDisplacements(shown.positions, atoms, vector, deg));
  };

  return (
    <div
      data-testid="builder-transform"
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div style={hintStyle}>Transform</div>
      <form
        style={{ ...rowStyle, flexWrap: "nowrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (editable) move();
        }}
      >
        <span style={{ ...hintStyle, width: 52 }}>Move by</span>
        {(["x", "y", "z"] as const).map((c, k) => (
          <input
            key={c}
            data-testid={`builder-transform-d${c}`}
            aria-label={`Move by ${c} in Å`}
            type="number"
            step={0.1}
            value={delta[k]}
            onChange={(e) => setDelta(delta.map((v, j) => (j === k ? e.target.value : v)))}
            style={{ ...inputStyle, width: 54, minWidth: 0 }}
          />
        ))}
        <span style={hintStyle}>Å</span>
        <button
          type="submit"
          data-testid="builder-transform-move"
          style={buttonStyle("default", !editable)}
          disabled={!editable}
        >
          Move
        </button>
      </form>
      <form
        style={{ ...rowStyle, flexWrap: "nowrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (editable) rotate();
        }}
      >
        <span style={{ ...hintStyle, width: 52 }}>Rotate</span>
        <input
          data-testid="builder-transform-angle"
          aria-label="Rotate by degrees"
          type="number"
          step={15}
          value={angle}
          onChange={(e) => setAngleText(e.target.value)}
          style={{ ...inputStyle, width: 64, minWidth: 0 }}
        />
        <span style={hintStyle}>° about</span>
        <select
          data-testid="builder-transform-axis"
          aria-label="Rotation axis"
          value={axes.includes(axis) ? axis : "z"}
          onChange={(e) => setAxis(e.target.value as AxisKey)}
          style={inputStyle}
        >
          {axes.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          type="submit"
          data-testid="builder-transform-rotate"
          style={buttonStyle("default", !editable)}
          disabled={!editable}
          title="Turns the selection about the axis through its centre"
        >
          Rotate
        </button>
      </form>
    </div>
  );
}
