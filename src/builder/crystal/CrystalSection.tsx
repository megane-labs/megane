/**
 * The sidebar's Crystal section: edit the cell (and wrap / centre in it),
 * build a supercell, cut a slab, and expand a CIF's symmetry. Every action is
 * one edit op pushed on the store, so it is undoable and travels with the
 * history. (Starting a bulk crystal is a new document and lives in the
 * "New structure" dialog.)
 */

import { useEffect, useMemo, useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import {
  buttonStyle,
  hintStyle,
  inputStyle,
  rowStyle,
  segmentGroupStyle,
  segmentStyle,
  toggleStyle,
} from "../styles";
import { boxToCellParams, cellParamsToBox, det3, type CellParams } from "../../crystal/cell";
import { slabPreview } from "../../crystal/transform";
import type { EditOp } from "../../pipeline/types";
import { newFragmentId } from "../library/fragment";
import { Section } from "../Section";
import { NumberField } from "./NumberField";

type Tab = "cell" | "supercell" | "slab";

/**
 * Most atoms a supercell or slab may produce. Each cut or repeat multiplies
 * the whole structure (a slab of a 4-layer slab has 4× the atoms, and so on),
 * and every op is replayed on each edit, so the Builder refuses a result the
 * tab could not hold rather than let a few clicks crash it.
 */
export const MAX_ATOMS = 1_000_000;

function overLimit(nAtoms: number): string {
  return `${nAtoms.toLocaleString("en-US")} atoms would exceed the ${MAX_ATOMS.toLocaleString(
    "en-US",
  )}-atom limit`;
}

const TABS: { value: Tab; label: string }[] = [
  { value: "cell", label: "Cell" },
  { value: "supercell", label: "Supercell" },
  { value: "slab", label: "Slab" },
];

const numStyle: React.CSSProperties = { ...inputStyle, width: 58 };

/** `a × b × c Å`, with the angles when the cell is not orthogonal. */
export function cellSummary(box: Float32Array): string {
  const p = boxToCellParams(box);
  const f = (v: number) => v.toFixed(2);
  const angles =
    Math.abs(p.alpha - 90) < 0.05 && Math.abs(p.beta - 90) < 0.05 && Math.abs(p.gamma - 90) < 0.05
      ? ""
      : ` · ${f(p.alpha)}° ${f(p.beta)}° ${f(p.gamma)}°`;
  return `${f(p.a)} × ${f(p.b)} × ${f(p.c)} Å${angles}`;
}

export function CrystalSection() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const pushOp = useBuilderStore((s) => s.pushOp);
  const reportError = useBuilderStore((s) => s.reportError);

  const editable = canEdit({ source, result, showOriginal });
  const shown = shownSnapshot({ source, result, showOriginal });
  const hasCell = !!shown?.box && Math.abs(det3(shown.box)) > 1e-9;
  const [tab, setTab] = useState<Tab>("cell");

  const apply = (op: EditOp) => {
    if (!editable) return;
    pushOp(op);
  };

  // A CIF's space-group operations can be applied once; afterwards the
  // structure is the full cell and the ops have been consumed.
  const symOps = source?.symmetryOps?.length ?? 0;
  const symmetryExpanded = edits.some((op) => op.op === "expand_symmetry");
  const symmetryConsumed =
    symmetryExpanded ||
    edits.some(
      (op) =>
        op.op === "supercell" ||
        op.op === "slab" ||
        op.op === "set_cell" ||
        (op.op === "center" && op.vacuum !== null && op.vacuum !== undefined),
    );

  return (
    <Section
      id="crystal"
      title="Crystal"
      summary={
        <span data-testid="builder-crystal-cell-summary">
          {shown && hasCell ? cellSummary(shown.box!) : "No cell"}
        </span>
      }
    >
      <div
        data-testid="builder-crystal"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        {symOps > 0 && !symmetryConsumed && (
          <div
            style={{
              ...rowStyle,
              padding: "6px 8px",
              borderRadius: 6,
              background: "rgba(37, 99, 235, 0.08)",
            }}
            data-testid="builder-crystal-symmetry"
          >
            <span style={hintStyle}>
              This file lists {symOps} symmetry operation{symOps === 1 ? "" : "s"} for its
              asymmetric unit.
            </span>
            <button
              type="button"
              data-testid="builder-crystal-expand-symmetry"
              style={buttonStyle("primary", !editable)}
              disabled={!editable}
              onClick={() => apply({ op: "expand_symmetry", id: newFragmentId("symmetry") })}
              title="Fill the unit cell with the symmetry-equivalent atoms (as the viewer's Symmetry node does)"
            >
              Expand symmetry
            </button>
          </div>
        )}
        <div style={segmentGroupStyle} role="tablist">
          {TABS.map((t) => (
            <span
              key={t.value}
              role="tab"
              data-testid={`builder-crystal-tab-${t.value}`}
              aria-selected={tab === t.value}
              style={segmentStyle(tab === t.value)}
              onClick={() => setTab(t.value)}
            >
              {t.label}
            </span>
          ))}
        </div>
        {!shown && (
          <div style={hintStyle} data-testid="builder-crystal-no-document">
            Open or create a structure first.
          </div>
        )}
        {shown && tab === "cell" && (
          <CellTab
            box={shown.box ?? null}
            hasCell={hasCell}
            nAtoms={shown.nAtoms}
            editable={editable}
            onApply={apply}
          />
        )}
        {shown && tab === "supercell" && hasCell && (
          <SupercellTab editable={editable} nAtoms={shown.nAtoms} onApply={apply} />
        )}
        {shown && tab === "slab" && hasCell && (
          <SlabTab editable={editable} source={shown} onApply={apply} onError={reportError} />
        )}
        {shown && !hasCell && (
          <div style={hintStyle} data-testid="builder-crystal-no-cell">
            {tab === "cell"
              ? "The structure has no cell yet; set one above."
              : "This needs a cell: set one in the Cell tab, or start from a bulk crystal (New…)."}
          </div>
        )}
      </div>
    </Section>
  );
}

// ── Cell ──

function CellTab({
  box,
  hasCell,
  nAtoms,
  editable,
  onApply,
}: {
  box: Float32Array | null;
  hasCell: boolean;
  nAtoms: number;
  editable: boolean;
  onApply: (op: EditOp) => void;
}) {
  const current = useMemo<CellParams>(
    () =>
      box && hasCell
        ? boxToCellParams(box)
        : { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
    [box, hasCell],
  );
  const [params, setParams] = useState<CellParams>(current);
  const [scaleAtoms, setScaleAtoms] = useState(true);
  const [vacuum, setVacuum] = useState(10);
  const [axes, setAxes] = useState<boolean[]>([false, false, true]);
  // Follow the document: a new structure or an undone edit refreshes the fields.
  useEffect(() => setParams(current), [current]);

  const valid =
    params.a > 0 &&
    params.b > 0 &&
    params.c > 0 &&
    params.alpha > 0 &&
    params.alpha < 180 &&
    params.beta > 0 &&
    params.beta < 180 &&
    params.gamma > 0 &&
    params.gamma < 180;
  const set = (key: keyof CellParams) => (v: number) => setParams({ ...params, [key]: v });
  const applyCell = () => {
    if (!valid) return;
    onApply({ op: "set_cell", box: cellParamsToBox(params), scaleAtoms: scaleAtoms && hasCell });
  };
  const chosenAxes = axes.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="builder-cell">
      <div style={rowStyle}>
        <NumberField
          label="a"
          value={params.a}
          onChange={set("a")}
          testId="builder-cell-a"
          step={0.01}
          min={0.01}
        />
        <NumberField
          label="b"
          value={params.b}
          onChange={set("b")}
          testId="builder-cell-b"
          step={0.01}
          min={0.01}
        />
        <NumberField
          label="c"
          value={params.c}
          onChange={set("c")}
          testId="builder-cell-c"
          step={0.01}
          min={0.01}
        />
      </div>
      <div style={rowStyle}>
        <NumberField
          label="α"
          value={params.alpha}
          onChange={set("alpha")}
          testId="builder-cell-alpha"
          step={0.1}
        />
        <NumberField
          label="β"
          value={params.beta}
          onChange={set("beta")}
          testId="builder-cell-beta"
          step={0.1}
        />
        <NumberField
          label="γ"
          value={params.gamma}
          onChange={set("gamma")}
          testId="builder-cell-gamma"
          step={0.1}
        />
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-cell-apply"
          style={buttonStyle("primary", !editable || !valid)}
          disabled={!editable || !valid}
          onClick={applyCell}
        >
          Set cell
        </button>
        <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            data-testid="builder-cell-scale-atoms"
            checked={scaleAtoms}
            onChange={(e) => setScaleAtoms(e.target.checked)}
            disabled={!hasCell}
          />
          move atoms with the cell
        </label>
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-cell-wrap"
          style={buttonStyle("default", !editable || !hasCell || nAtoms === 0)}
          disabled={!editable || !hasCell || nAtoms === 0}
          onClick={() => onApply({ op: "wrap" })}
          title="Fold every atom back into the cell"
        >
          Wrap atoms
        </button>
        <button
          type="button"
          data-testid="builder-cell-remove"
          style={buttonStyle("danger", !editable || !hasCell)}
          disabled={!editable || !hasCell}
          onClick={() => onApply({ op: "set_cell", box: null })}
        >
          Remove cell
        </button>
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-cell-center"
          style={buttonStyle("default", !editable || !hasCell || chosenAxes.length === 0)}
          disabled={!editable || !hasCell || chosenAxes.length === 0}
          onClick={() => onApply({ op: "center", axes: chosenAxes, vacuum })}
          title="Centre the atoms and resize the chosen cell vectors to leave this much vacuum on each side"
        >
          Center + vacuum
        </button>
        <NumberField
          label=""
          value={vacuum}
          onChange={setVacuum}
          testId="builder-cell-vacuum"
          step={0.5}
          min={0}
          title="Vacuum on each side, Å"
        />
        <span style={hintStyle}>Å along</span>
        {["a", "b", "c"].map((name, i) => (
          <span
            key={name}
            role="button"
            data-testid={`builder-cell-axis-${name}`}
            aria-pressed={axes[i]}
            style={toggleStyle(axes[i])}
            onClick={() => setAxes(axes.map((on, k) => (k === i ? !on : on)))}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Supercell ──

function SupercellTab({
  editable,
  nAtoms,
  onApply,
}: {
  editable: boolean;
  nAtoms: number;
  onApply: (op: EditOp) => void;
}) {
  const [n, setN] = useState([2, 2, 2]);
  const [advanced, setAdvanced] = useState(false);
  const [matrix, setMatrix] = useState([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const effective = advanced ? matrix : [n[0], 0, 0, 0, n[1], 0, 0, 0, n[2]];
  const images = effective.every(Number.isInteger) ? Math.round(Math.abs(det3(effective))) : 0;
  const total = nAtoms * images;
  const tooMany = total > MAX_ATOMS;
  const valid = images >= 1 && !tooMany;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
      data-testid="builder-supercell"
    >
      <div style={rowStyle}>
        {!advanced ? (
          ["a", "b", "c"].map((name, i) => (
            <NumberField
              key={name}
              label={`n${name}`}
              value={n[i]}
              onChange={(v) => setN(n.map((x, k) => (k === i ? v : x)))}
              testId={`builder-supercell-n${name}`}
              min={1}
              width={50}
            />
          ))
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 50px)", gap: 4 }}>
            {matrix.map((v, k) => (
              <input
                key={k}
                type="number"
                data-testid={`builder-supercell-m${k}`}
                value={v}
                onChange={(e) =>
                  setMatrix(matrix.map((x, i) => (i === k ? Number(e.target.value) : x)))
                }
                style={{ ...numStyle, width: 50 }}
              />
            ))}
          </div>
        )}
        <span
          role="button"
          data-testid="builder-supercell-advanced"
          aria-pressed={advanced}
          style={toggleStyle(advanced)}
          onClick={() => setAdvanced(!advanced)}
          title="Integer transformation matrix: rows are the new lattice vectors in units of the old ones"
        >
          Matrix
        </span>
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-supercell-apply"
          style={buttonStyle("primary", !editable || !valid)}
          disabled={!editable || !valid}
          onClick={() =>
            onApply({ op: "supercell", id: newFragmentId("supercell"), matrix: effective })
          }
        >
          Make supercell
        </button>
        <span style={hintStyle} data-testid="builder-supercell-preview">
          {valid
            ? `${images} image${images === 1 ? "" : "s"} → ${total} atoms`
            : tooMany
              ? overLimit(total)
              : "Invalid matrix"}
        </span>
      </div>
    </div>
  );
}

// ── Slab ──

function SlabTab({
  editable,
  source,
  onApply,
  onError,
}: {
  editable: boolean;
  source: ReturnType<typeof shownSnapshot>;
  onApply: (op: EditOp) => void;
  onError: (msg: string) => void;
}) {
  const [miller, setMiller] = useState([1, 1, 1]);
  const [layers, setLayers] = useState(4);
  const [vacuum, setVacuum] = useState(10);
  const [shift, setShift] = useState(0);
  const millerValid = miller.every(Number.isInteger) && miller.some((v) => v !== 0);
  const valid = millerValid && layers >= 1 && vacuum >= 0;

  // What the cut would produce, for the summary line: the count and the
  // thickness alone, without building the slab (and its bonds) on every
  // keystroke — the result is `layers` times the structure.
  const preview = useMemo(() => {
    if (!source?.box || !valid || !editable) return null;
    return slabPreview(source, {
      miller: miller as [number, number, number],
      layers,
      vacuum,
      shift,
    });
  }, [source, miller, layers, vacuum, shift, valid, editable]);
  const tooMany = preview !== null && preview.nAtoms > MAX_ATOMS;

  const create = () => {
    if (!valid || tooMany) return;
    if (!preview) {
      onError("Could not build a slab from this cell.");
      return;
    }
    onApply({
      op: "slab",
      id: newFragmentId("slab"),
      miller: miller as [number, number, number],
      layers,
      vacuum,
      ...(shift ? { shift } : {}),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="builder-slab">
      <div style={rowStyle}>
        {["h", "k", "l"].map((name, i) => (
          <NumberField
            key={name}
            label={name}
            value={miller[i]}
            onChange={(v) => setMiller(miller.map((x, k) => (k === i ? v : x)))}
            testId={`builder-slab-${name}`}
            width={46}
          />
        ))}
        <NumberField
          label="layers"
          value={layers}
          onChange={setLayers}
          testId="builder-slab-layers"
          min={1}
          width={50}
        />
        <NumberField
          label="vacuum"
          value={vacuum}
          onChange={setVacuum}
          testId="builder-slab-vacuum"
          step={0.5}
          min={0}
          title="Vacuum on each side along the normal, Å; 0 keeps the slab periodic"
        />
      </div>
      <label style={{ ...rowStyle, ...hintStyle, flexWrap: "nowrap" }}>
        termination
        <input
          type="range"
          data-testid="builder-slab-shift"
          min={0}
          max={0.99}
          step={0.01}
          value={shift}
          onChange={(e) => setShift(Number(e.target.value))}
          style={{ flex: 1 }}
          title="Slide the cut along the surface normal to choose the termination"
        />
        {shift.toFixed(2)}
      </label>
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-slab-apply"
          style={buttonStyle("primary", !editable || !valid || tooMany)}
          disabled={!editable || !valid || tooMany}
          onClick={create}
        >
          Cut slab
        </button>
        <span style={hintStyle} data-testid="builder-slab-preview">
          {preview
            ? tooMany
              ? overLimit(preview.nAtoms)
              : `${preview.nAtoms} atoms, ${preview.thickness.toFixed(1)} Å thick`
            : millerValid
              ? ""
              : "Miller indices must be integers, not all zero"}
        </span>
      </div>
    </div>
  );
}
