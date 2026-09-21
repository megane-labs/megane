/**
 * The sidebar's Crystal section: start a bulk crystal, edit the cell (and
 * wrap / centre in it), build a supercell, cut a slab, and expand a CIF's
 * symmetry. Every action is either a new document (`newBulk`) or one edit op
 * pushed on the store, so it is undoable and travels with the history.
 */

import { useEffect, useMemo, useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import { chipStyle, hintStyle, inputStyle, sectionStyle, sectionTitleStyle } from "../styles";
import {
  BULK_EXAMPLES,
  BULK_STRUCTURES,
  bulkStructureInfo,
  elementFromSymbol,
  type BulkSpec,
  type BulkStructure,
} from "../../crystal/bulk";
import { boxToCellParams, cellParamsToBox, det3, type CellParams } from "../../crystal/cell";
import { buildSlab } from "../../crystal/transform";
import { getElementSymbol } from "../../constants";
import type { EditOp } from "../../pipeline/types";
import { newFragmentId } from "../library/fragment";

type Tab = "bulk" | "cell" | "supercell" | "slab";

const TABS: { value: Tab; label: string }[] = [
  { value: "bulk", label: "Bulk" },
  { value: "cell", label: "Cell" },
  { value: "supercell", label: "Supercell" },
  { value: "slab", label: "Slab" },
];

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};

const numStyle: React.CSSProperties = { ...inputStyle, width: 58 };

function NumberField({
  label,
  value,
  onChange,
  testId,
  step = 1,
  min,
  width,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testId: string;
  step?: number;
  min?: number;
  width?: number;
  title?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 3 }} title={title}>
      <span style={hintStyle}>{label}</span>
      <input
        type="number"
        data-testid={testId}
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        style={width ? { ...numStyle, width } : numStyle}
      />
    </label>
  );
}

export function CrystalSection() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const pushOp = useBuilderStore((s) => s.pushOp);
  const newBulk = useBuilderStore((s) => s.newBulk);

  const editable = canEdit({ source, result, showOriginal });
  const shown = shownSnapshot({ source, result, showOriginal });
  const hasCell = !!shown?.box && Math.abs(det3(shown.box)) > 1e-9;
  const [tab, setTab] = useState<Tab>("bulk");
  const [error, setError] = useState<string | null>(null);

  const apply = (op: EditOp) => {
    if (!editable) return;
    setError(null);
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
    <div style={sectionStyle} data-testid="builder-crystal">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={sectionTitleStyle}>Crystal</span>
        <span style={hintStyle} data-testid="builder-crystal-cell-summary">
          {shown && hasCell ? cellSummary(shown.box!) : "No cell"}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {TABS.map((t) => (
          <span
            key={t.value}
            role="button"
            data-testid={`builder-crystal-tab-${t.value}`}
            aria-pressed={tab === t.value}
            style={chipStyle(tab === t.value)}
            onClick={() => {
              setTab(t.value);
              setError(null);
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
      {symOps > 0 && !symmetryConsumed && (
        <div style={rowStyle} data-testid="builder-crystal-symmetry">
          <span style={hintStyle}>
            This file lists {symOps} symmetry operation{symOps === 1 ? "" : "s"} for its asymmetric
            unit.
          </span>
          <span
            role="button"
            data-testid="builder-crystal-expand-symmetry"
            style={chipStyle(false, !editable)}
            onClick={
              editable
                ? () => apply({ op: "expand_symmetry", id: newFragmentId("symmetry") })
                : undefined
            }
            title="Fill the unit cell with the symmetry-equivalent atoms (as the viewer's Symmetry node does)"
          >
            Expand symmetry
          </span>
        </div>
      )}
      {tab === "bulk" && <BulkTab onCreate={newBulk} onError={setError} />}
      {tab === "cell" && (
        <CellTab
          box={shown?.box ?? null}
          hasCell={hasCell}
          nAtoms={shown?.nAtoms ?? 0}
          editable={editable}
          onApply={apply}
        />
      )}
      {tab === "supercell" && (
        <SupercellTab editable={editable && hasCell} nAtoms={shown?.nAtoms ?? 0} onApply={apply} />
      )}
      {tab === "slab" && (
        <SlabTab editable={editable && hasCell} source={shown} onApply={apply} onError={setError} />
      )}
      {!hasCell && tab !== "bulk" && shown && (
        <div style={hintStyle} data-testid="builder-crystal-no-cell">
          {tab === "cell"
            ? "The structure has no cell yet; set one below."
            : "This needs a cell: set one in the Cell tab or start from a bulk crystal."}
        </div>
      )}
      {error && (
        <div data-testid="builder-crystal-error" style={{ ...hintStyle, color: "#b91c1c" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function cellSummary(box: Float32Array): string {
  const p = boxToCellParams(box);
  const f = (v: number) => v.toFixed(2);
  const angles =
    Math.abs(p.alpha - 90) < 0.05 && Math.abs(p.beta - 90) < 0.05 && Math.abs(p.gamma - 90) < 0.05
      ? ""
      : ` · ${f(p.alpha)}° ${f(p.beta)}° ${f(p.gamma)}°`;
  return `${f(p.a)} × ${f(p.b)} × ${f(p.c)} Å${angles}`;
}

// ── Bulk ──

function BulkTab({
  onCreate,
  onError,
}: {
  onCreate: (spec: BulkSpec) => void;
  onError: (msg: string | null) => void;
}) {
  const [structure, setStructure] = useState<BulkStructure>("fcc");
  const [symbols, setSymbols] = useState(["Cu", "", ""]);
  const [a, setA] = useState(3.61);
  const [covera, setCovera] = useState(Math.sqrt(8 / 3));
  const [cubic, setCubic] = useState(true);
  const info = bulkStructureInfo(structure);

  const loadExample = (name: string) => {
    const ex = BULK_EXAMPLES.find((e) => e.name === name);
    if (!ex) return;
    const exInfo = bulkStructureInfo(ex.spec.structure);
    setStructure(ex.spec.structure);
    setSymbols(
      [0, 1, 2].map((k) => (k < exInfo.species ? getElementSymbol(ex.spec.elements[k]) : "")),
    );
    setA(ex.spec.a);
    if (ex.spec.covera !== undefined) setCovera(ex.spec.covera);
    setCubic(ex.spec.cubic ?? false);
  };

  const create = () => {
    const elements: number[] = [];
    for (let k = 0; k < info.species; k++) {
      const z = elementFromSymbol(symbols[k]);
      if (z === null) {
        onError(`Species ${"ABX"[k]}: "${symbols[k]}" is not an element symbol.`);
        return;
      }
      elements.push(z);
    }
    const spec: BulkSpec = { structure, elements, a };
    if (info.hexagonal) spec.covera = covera;
    if (info.cubic) spec.cubic = cubic;
    try {
      onCreate(spec);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="builder-bulk">
      <div style={rowStyle}>
        <select
          data-testid="builder-bulk-example"
          value=""
          onChange={(e) => loadExample(e.target.value)}
          style={inputStyle}
          title="Fill the fields from a reference structure"
        >
          <option value="">Examples…</option>
          {BULK_EXAMPLES.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.name}
            </option>
          ))}
        </select>
        <select
          data-testid="builder-bulk-structure"
          value={structure}
          onChange={(e) => setStructure(e.target.value as BulkStructure)}
          style={inputStyle}
        >
          {BULK_STRUCTURES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        {Array.from({ length: info.species }, (_, k) => (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={hintStyle}>{"ABX"[k]}</span>
            <input
              data-testid={`builder-bulk-element-${k}`}
              value={symbols[k]}
              onChange={(e) => setSymbols(symbols.map((s, i) => (i === k ? e.target.value : s)))}
              style={{ ...inputStyle, width: 40 }}
              placeholder="El"
            />
          </label>
        ))}
        <NumberField
          label="a"
          value={a}
          onChange={setA}
          testId="builder-bulk-a"
          step={0.01}
          min={0.1}
          title="Lattice constant, Å"
        />
        {info.hexagonal && (
          <NumberField
            label="c/a"
            value={covera}
            onChange={setCovera}
            testId="builder-bulk-covera"
            step={0.001}
            min={0.1}
            width={66}
          />
        )}
        {info.cubic && (
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              data-testid="builder-bulk-cubic"
              checked={cubic}
              onChange={(e) => setCubic(e.target.checked)}
            />
            conventional cell
          </label>
        )}
      </div>
      <div style={rowStyle}>
        <span
          role="button"
          data-testid="builder-bulk-create"
          style={chipStyle(false)}
          onClick={create}
          title="Start from this bulk crystal (replaces the open structure)"
        >
          New bulk crystal
        </span>
        <span style={hintStyle}>Replaces the open structure.</span>
      </div>
    </div>
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
        <span
          role="button"
          data-testid="builder-cell-apply"
          style={chipStyle(false, !editable || !valid)}
          onClick={editable && valid ? applyCell : undefined}
        >
          Set cell
        </span>
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
        <span
          role="button"
          data-testid="builder-cell-remove"
          style={chipStyle(false, !editable || !hasCell)}
          onClick={editable && hasCell ? () => onApply({ op: "set_cell", box: null }) : undefined}
        >
          Remove cell
        </span>
      </div>
      <div style={rowStyle}>
        <span
          role="button"
          data-testid="builder-cell-wrap"
          style={chipStyle(false, !editable || !hasCell || nAtoms === 0)}
          onClick={editable && hasCell && nAtoms > 0 ? () => onApply({ op: "wrap" }) : undefined}
          title="Fold every atom back into the cell"
        >
          Wrap atoms
        </span>
        <span
          role="button"
          data-testid="builder-cell-center"
          style={chipStyle(false, !editable || !hasCell || chosenAxes.length === 0)}
          onClick={
            editable && hasCell && chosenAxes.length > 0
              ? () => onApply({ op: "center", axes: chosenAxes, vacuum })
              : undefined
          }
          title="Centre the atoms and resize the chosen cell vectors to leave this much vacuum on each side"
        >
          Center + vacuum
        </span>
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
            style={chipStyle(axes[i])}
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
  const valid = images >= 1;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
      data-testid="builder-supercell"
    >
      {!advanced ? (
        <div style={rowStyle}>
          {["a", "b", "c"].map((name, i) => (
            <NumberField
              key={name}
              label={`n${name}`}
              value={n[i]}
              onChange={(v) => setN(n.map((x, k) => (k === i ? v : x)))}
              testId={`builder-supercell-n${name}`}
              min={1}
              width={50}
            />
          ))}
        </div>
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
      <div style={rowStyle}>
        <span
          role="button"
          data-testid="builder-supercell-apply"
          style={chipStyle(false, !editable || !valid)}
          onClick={
            editable && valid
              ? () =>
                  onApply({ op: "supercell", id: newFragmentId("supercell"), matrix: effective })
              : undefined
          }
        >
          Make supercell
        </span>
        <span
          role="button"
          data-testid="builder-supercell-advanced"
          aria-pressed={advanced}
          style={chipStyle(advanced)}
          onClick={() => setAdvanced(!advanced)}
          title="Integer transformation matrix: rows are the new lattice vectors in units of the old ones"
        >
          Matrix
        </span>
        <span style={hintStyle} data-testid="builder-supercell-preview">
          {valid
            ? `${images} image${images === 1 ? "" : "s"} → ${nAtoms * images} atoms`
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
  onError: (msg: string | null) => void;
}) {
  const [miller, setMiller] = useState([1, 1, 1]);
  const [layers, setLayers] = useState(4);
  const [vacuum, setVacuum] = useState(10);
  const [shift, setShift] = useState(0);
  const millerValid = miller.every(Number.isInteger) && miller.some((v) => v !== 0);
  const valid = millerValid && layers >= 1 && vacuum >= 0;

  // What the cut would produce, for the summary line.
  const preview = useMemo(() => {
    if (!source?.box || !valid || !editable) return null;
    return buildSlab(source, {
      miller: miller as [number, number, number],
      layers,
      vacuum,
      shift,
    });
  }, [source, miller, layers, vacuum, shift, valid, editable]);

  const create = () => {
    if (!valid) return;
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
      <label style={{ ...rowStyle, ...hintStyle }}>
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
        <span
          role="button"
          data-testid="builder-slab-apply"
          style={chipStyle(false, !editable || !valid)}
          onClick={editable && valid ? create : undefined}
        >
          Cut slab
        </span>
        <span style={hintStyle} data-testid="builder-slab-preview">
          {preview
            ? `${preview.nAtoms} atoms, ${slabThickness(preview).toFixed(1)} Å thick`
            : millerValid
              ? ""
              : "Miller indices must be integers, not all zero"}
        </span>
      </div>
    </div>
  );
}

function slabThickness(snap: { nAtoms: number; positions: Float32Array }): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < snap.nAtoms; i++) {
    const zc = snap.positions[i * 3 + 2];
    if (zc < lo) lo = zc;
    if (zc > hi) hi = zc;
  }
  return snap.nAtoms > 0 ? hi - lo : 0;
}
