/**
 * The Structure menu's dialogs: set the cell, centre the atoms with vacuum,
 * build a supercell, cut a slab. One operation per dialog, each a form in the
 * Details panel beside the 3D view so the view stays visible: while its fields make
 * a valid op, the view shows that op applied (`BuilderStore.setPreview`), and
 * *Apply* writes it as one undoable edit. Cancel, Escape or closing drops the
 * preview and leaves the document as it was.
 *
 * (Wrap, Remove cell and Expand symmetry take no parameters and run straight
 * from the menu; starting a bulk crystal is a new document and lives in the
 * "New structure" dialog.)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DetailForm } from "../DetailForm";
import { canEdit, shownSnapshot } from "../store";
import { buttonStyle, hintStyle, rowStyle, toggleStyle } from "../styles";
import {
  boxToCellParams,
  cellParamsToBox,
  det3,
  inverse3,
  type CellParams,
  type Vec3,
} from "../../crystal/cell";
import { slabPreview, surfaceBasis } from "../../crystal/transform";
import type { EditOp } from "../../pipeline/types";
import type { Snapshot } from "../../types";
import { newFragmentId } from "../library/fragment";
import { NumberField, numberProblem } from "./NumberField";
import { hasCellBox } from "./structure";
import { useScopedBuilderStore } from "../BuilderStores";

export type CrystalDialogKind = "cell" | "center" | "supercell" | "slab";

/**
 * Most atoms a supercell or slab may produce. Each cut or repeat multiplies
 * the whole structure (a slab of a 4-layer slab has 4× the atoms, and so on),
 * and every op is replayed on each edit, so the Builder refuses a result the
 * tab could not hold rather than let a few clicks crash it.
 */
export const MAX_ATOMS = 1_000_000;

/**
 * Most atoms the view previews while a dialog is open. Building the result
 * on every change of a field is the cost of the preview, so beyond this the
 * dialog only announces the count and the view waits for Apply.
 */
export const PREVIEW_MAX_ATOMS = 200_000;

/** Pause after the last change of a field before the preview is rebuilt, ms. */
export const PREVIEW_DELAY_MS = 120;

/** Fragment id the preview's supercell / slab atoms carry; Apply gives a fresh one. */
const PREVIEW_ID = "preview";

function overLimit(nAtoms: number): string {
  return `${nAtoms.toLocaleString("en-US")} atoms would exceed the ${MAX_ATOMS.toLocaleString(
    "en-US",
  )}-atom limit`;
}

/** The line under a form that says why Apply is off. */
function Problem({ text, testId = "builder-crystal-problem" }: { text: string; testId?: string }) {
  return (
    <span
      role="status"
      data-testid={testId}
      style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
    >
      {text}
    </span>
  );
}

const KINDS: Record<
  CrystalDialogKind,
  { title: string; apply: string; applyTestId: string; needsCell: boolean }
> = {
  cell: { title: "Cell", apply: "Set cell", applyTestId: "builder-cell-apply", needsCell: false },
  center: {
    title: "Center with vacuum",
    apply: "Center",
    applyTestId: "builder-cell-center",
    needsCell: true,
  },
  supercell: {
    title: "Supercell",
    apply: "Make supercell",
    applyTestId: "builder-supercell-apply",
    needsCell: true,
  },
  slab: {
    title: "Cut slab",
    apply: "Cut slab",
    applyTestId: "builder-slab-apply",
    needsCell: true,
  },
};

/** A form's current op (null while its fields are invalid) and the atoms it would give. */
type Draft = { op: EditOp | null; nAtoms: number };
type OnDraft = (op: EditOp | null, nAtoms: number) => void;

/** The op Apply writes: the preview's with a fresh fragment id where it has one. */
function committed(op: EditOp): EditOp {
  return op.op === "supercell" || op.op === "slab" ? { ...op, id: newFragmentId(op.op) } : op;
}

export function CrystalDialog({ kind, onClose }: { kind: CrystalDialogKind; onClose: () => void }) {
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const pushOp = useScopedBuilderStore((s) => s.pushOp);
  const setPreview = useScopedBuilderStore((s) => s.setPreview);
  const previewing = useScopedBuilderStore((s) => s.preview !== null);

  // The committed structure, never the preview: the forms read their defaults
  // from it, and editing is judged without the preview this dialog set.
  const doc = shownSnapshot({ source, result, showOriginal });
  const editable = canEdit({ source, result, showOriginal });
  const hasCell = hasCellBox(doc?.box);
  const spec = KINDS[kind];

  const [draft, setDraft] = useState<Draft>({ op: null, nAtoms: 0 });
  const onDraft = useCallback<OnDraft>((op, nAtoms) => setDraft({ op, nAtoms }), []);
  const previewable = !!draft.op && editable && draft.nAtoms <= PREVIEW_MAX_ATOMS;

  // Rebuilt when the fields change and when the document does: an Undo while
  // the dialog is open drops the preview, and this puts it back on the new
  // structure.
  useEffect(() => {
    if (!previewable) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => setPreview(draft.op), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, previewable, setPreview, result]);
  // Closing the dialog, however it happens, leaves no preview behind.
  useEffect(() => () => setPreview(null), [setPreview]);

  const canApply = !!draft.op && editable && (!spec.needsCell || hasCell);
  const apply = () => {
    if (!canApply) return;
    pushOp(committed(draft.op!));
    onClose();
  };

  return (
    <DetailForm
      testId="builder-crystal-dialog"
      data={{ "data-kind": kind }}
      title={spec.title}
      breadcrumb="Structure ›"
      onClose={onClose}
    >
      {!doc ? (
        <div style={hintStyle} data-testid="builder-crystal-no-document">
          Open or create a structure first.
        </div>
      ) : spec.needsCell && !hasCell ? (
        <div style={hintStyle} data-testid="builder-crystal-no-cell">
          This needs a cell: set one with Structure › Set cell…, or start from a bulk crystal
          (New…).
        </div>
      ) : kind === "cell" ? (
        <CellForm box={doc.box ?? null} hasCell={hasCell} nAtoms={doc.nAtoms} onDraft={onDraft} />
      ) : kind === "center" ? (
        <CenterForm nAtoms={doc.nAtoms} onDraft={onDraft} />
      ) : kind === "supercell" ? (
        <SupercellForm nAtoms={doc.nAtoms} onDraft={onDraft} />
      ) : (
        <SlabForm snapshot={doc} onDraft={onDraft} />
      )}

      {draft.op && (
        <div style={hintStyle} data-testid="builder-crystal-preview-status">
          {!editable
            ? "Editing is paused while the original structure is shown."
            : previewable
              ? previewing
                ? "The view shows the result; Apply keeps it."
                : "Previewing…"
              : `Too large to preview (${draft.nAtoms.toLocaleString("en-US")} atoms); Apply builds it.`}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          data-testid="builder-crystal-cancel"
          style={buttonStyle()}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid={spec.applyTestId}
          style={buttonStyle("primary", !canApply)}
          disabled={!canApply}
          onClick={apply}
        >
          {spec.apply}
        </button>
      </div>
    </DetailForm>
  );
}

// ── Cell ──

function CellForm({
  box,
  hasCell,
  nAtoms,
  onDraft,
}: {
  box: Float32Array | null;
  hasCell: boolean;
  nAtoms: number;
  onDraft: OnDraft;
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
  // Follow the document: a new structure or an undone edit refreshes the fields.
  useEffect(() => setParams(current), [current]);

  const problem = cellProblem(params);
  const op = useMemo<EditOp | null>(
    () =>
      problem === null
        ? { op: "set_cell", box: cellParamsToBox(params), scaleAtoms: scaleAtoms && hasCell }
        : null,
    [problem, params, scaleAtoms, hasCell],
  );
  useEffect(() => onDraft(op, nAtoms), [op, nAtoms, onDraft]);
  const set = (key: keyof CellParams) => (v: number) => setParams({ ...params, [key]: v });

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
          unit="Å"
        />
        <NumberField
          label="b"
          value={params.b}
          onChange={set("b")}
          testId="builder-cell-b"
          step={0.01}
          min={0.01}
          unit="Å"
        />
        <NumberField
          label="c"
          value={params.c}
          onChange={set("c")}
          testId="builder-cell-c"
          step={0.01}
          min={0.01}
          unit="Å"
        />
      </div>
      <div style={rowStyle}>
        <NumberField
          label="α"
          value={params.alpha}
          onChange={set("alpha")}
          testId="builder-cell-alpha"
          step={0.1}
          min={0}
          unit="°"
        />
        <NumberField
          label="β"
          value={params.beta}
          onChange={set("beta")}
          testId="builder-cell-beta"
          step={0.1}
          min={0}
          unit="°"
        />
        <NumberField
          label="γ"
          value={params.gamma}
          onChange={set("gamma")}
          testId="builder-cell-gamma"
          step={0.1}
          min={0}
          unit="°"
        />
      </div>
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
      {problem && <Problem text={problem} />}
    </div>
  );
}

/** Why `p` is not a cell (the first problem), or null. */
export function cellProblem(p: CellParams): string | null {
  for (const key of ["a", "b", "c"] as const) {
    const problem = numberProblem(key, p[key], { min: 0, exclusiveMin: true, unit: "Å" });
    if (problem) return problem;
  }
  for (const [key, label] of [
    ["alpha", "α"],
    ["beta", "β"],
    ["gamma", "γ"],
  ] as const) {
    const problem = numberProblem(label, p[key], {
      min: 0,
      exclusiveMin: true,
      max: 180,
      exclusiveMax: true,
      unit: "°",
    });
    if (problem) return problem;
  }
  const { alpha, beta, gamma } = p;
  if (
    alpha + beta + gamma >= 360 ||
    alpha >= beta + gamma ||
    beta >= alpha + gamma ||
    gamma >= alpha + beta
  ) {
    return "These angles do not close into a cell: each must be less than the sum of the other two, and all three less than 360°.";
  }
  return null;
}

// ── Center with vacuum ──

function CenterForm({ nAtoms, onDraft }: { nAtoms: number; onDraft: OnDraft }) {
  const [vacuum, setVacuum] = useState(10);
  const [axes, setAxes] = useState<boolean[]>([false, false, true]);
  const chosen = axes.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  const problem =
    numberProblem("Vacuum", vacuum, { min: 0, unit: "Å" }) ??
    (chosen.length === 0 ? "Choose at least one axis (a, b or c) to centre along." : null);
  const axesKey = chosen.join(",");
  const op = useMemo<EditOp | null>(
    () =>
      problem === null ? { op: "center", axes: axesKey.split(",").map(Number), vacuum } : null,
    [problem, axesKey, vacuum],
  );
  useEffect(() => onDraft(op, nAtoms), [op, nAtoms, onDraft]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="builder-center">
      <span style={hintStyle}>
        Centre the atoms and resize the chosen cell vectors to leave this much vacuum on each side.
      </span>
      <div style={rowStyle}>
        <NumberField
          label="vacuum"
          value={vacuum}
          onChange={setVacuum}
          testId="builder-cell-vacuum"
          step={0.5}
          min={0}
          unit="Å"
          title="Vacuum on each side, Å"
        />
        <span style={hintStyle}>Å along</span>
        {["a", "b", "c"].map((name, i) => (
          <button
            key={name}
            type="button"
            data-testid={`builder-cell-axis-${name}`}
            aria-pressed={axes[i]}
            style={toggleStyle(axes[i])}
            onClick={() => setAxes(axes.map((on, k) => (k === i ? !on : on)))}
          >
            {name}
          </button>
        ))}
      </div>
      {problem && <Problem text={problem} />}
    </div>
  );
}

// ── Supercell ──

function SupercellForm({ nAtoms, onDraft }: { nAtoms: number; onDraft: OnDraft }) {
  const [n, setN] = useState([2, 2, 2]);
  const [advanced, setAdvanced] = useState(false);
  const [matrix, setMatrix] = useState([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const effective = useMemo(
    () => (advanced ? matrix : [n[0], 0, 0, 0, n[1], 0, 0, 0, n[2]]),
    [advanced, matrix, n],
  );
  const images = effective.every(Number.isInteger) ? Math.round(Math.abs(det3(effective))) : 0;
  const total = nAtoms * images;
  const tooMany = total > MAX_ATOMS;
  const valid = images >= 1 && !tooMany;
  const problem = !advanced
    ? n.every((v) => Number.isInteger(v) && v >= 1)
      ? null
      : "Repeats must be whole numbers ≥ 1"
    : !matrix.every(Number.isInteger)
      ? "Matrix entries must be whole numbers"
      : images < 1
        ? "The matrix is singular (determinant 0): its rows must span a volume"
        : null;
  /** Matrix mode starts from the repeats set so far: diag(na, nb, nc). */
  const toggleAdvanced = () => {
    if (!advanced) {
      const d = n.map((v) => (Number.isInteger(v) && v >= 1 ? v : 1));
      setMatrix([d[0], 0, 0, 0, d[1], 0, 0, 0, d[2]]);
    }
    setAdvanced(!advanced);
  };
  const op = useMemo<EditOp | null>(
    () => (valid ? { op: "supercell", id: PREVIEW_ID, matrix: effective } : null),
    [valid, effective],
  );
  useEffect(() => onDraft(op, total), [op, total, onDraft]);

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
              onChange={(v) => setN((cur) => cur.map((x, k) => (k === i ? v : x)))}
              testId={`builder-supercell-n${name}`}
              min={1}
              integer
              width={50}
            />
          ))
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 50px)", gap: 4 }}>
            {matrix.map((v, k) => (
              <NumberField
                key={k}
                label=""
                testId={`builder-supercell-m${k}`}
                ariaLabel={`Matrix row ${Math.floor(k / 3) + 1}, column ${(k % 3) + 1}`}
                value={v}
                integer
                width={50}
                onChange={(x) => setMatrix((m) => m.map((y, i) => (i === k ? x : y)))}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          data-testid="builder-supercell-advanced"
          aria-pressed={advanced}
          style={toggleStyle(advanced)}
          onClick={toggleAdvanced}
          title="Integer transformation matrix: rows are the new lattice vectors in units of the old ones"
        >
          Matrix
        </button>
      </div>
      {valid ? (
        <span style={hintStyle} data-testid="builder-supercell-preview">
          {`${images} image${images === 1 ? "" : "s"} → ${total} atoms`}
        </span>
      ) : (
        <Problem
          testId="builder-supercell-preview"
          text={problem ?? (tooMany ? overLimit(total) : "Invalid matrix")}
        />
      )}
    </div>
  );
}

// ── Slab ──

function SlabForm({ snapshot, onDraft }: { snapshot: Snapshot; onDraft: OnDraft }) {
  const [miller, setMiller] = useState([1, 1, 1]);
  const [layers, setLayers] = useState(4);
  const [vacuum, setVacuum] = useState(10);
  const [shift, setShift] = useState(0);
  const millerValid = miller.every(Number.isInteger) && miller.some((v) => v !== 0);
  const fieldProblem = !millerValid
    ? "Miller indices must be integers, not all zero"
    : (numberProblem("Layers", layers, { min: 1, integer: true }) ??
      numberProblem("Vacuum", vacuum, { min: 0, unit: "Å" }));
  const valid = fieldProblem === null;

  // What the cut would produce, for the summary line: the count and the
  // thickness alone, without building the slab (and its bonds) — the result
  // is `layers` times the structure.
  const summary = useMemo(() => {
    if (!snapshot.box || !valid) return null;
    return slabPreview(snapshot, {
      miller: miller as [number, number, number],
      layers,
      vacuum,
      shift,
    });
  }, [snapshot, miller, layers, vacuum, shift, valid]);
  const tooMany = summary !== null && summary.nAtoms > MAX_ATOMS;
  const op = useMemo<EditOp | null>(
    () =>
      valid && summary && !tooMany
        ? {
            op: "slab",
            id: PREVIEW_ID,
            miller: miller as [number, number, number],
            layers,
            vacuum,
            ...(shift ? { shift } : {}),
          }
        : null,
    [valid, summary, tooMany, miller, layers, vacuum, shift],
  );
  useEffect(() => onDraft(op, summary?.nAtoms ?? 0), [op, summary, onDraft]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="builder-slab">
      <div style={rowStyle}>
        {["h", "k", "l"].map((name, i) => (
          <NumberField
            key={name}
            label={name}
            value={miller[i]}
            onChange={(v) => setMiller((cur) => cur.map((x, k) => (k === i ? v : x)))}
            testId={`builder-slab-${name}`}
            integer
            width={46}
          />
        ))}
      </div>
      <div style={rowStyle}>
        <NumberField
          label="layers"
          value={layers}
          onChange={setLayers}
          testId="builder-slab-layers"
          min={1}
          integer
          width={50}
        />
        <NumberField
          label="vacuum"
          value={vacuum}
          onChange={setVacuum}
          testId="builder-slab-vacuum"
          step={0.5}
          min={0}
          unit="Å"
          title="Vacuum on each side along the normal, Å; 0 keeps the slab periodic"
        />
      </div>
      <label
        style={{ ...rowStyle, ...hintStyle, flexWrap: "nowrap" }}
        title="Where the cut falls, as a fraction of the interlayer spacing along the normal"
      >
        <span>
          termination
          <br />
          <span style={{ fontSize: 10 }}>(fraction of the interlayer spacing)</span>
        </span>
        <input
          type="range"
          data-testid="builder-slab-shift"
          min={0}
          max={0.99}
          step={0.01}
          value={shift}
          onChange={(e) => setShift(Number(e.target.value))}
          style={{ flex: 1 }}
          aria-label="Termination: fraction of the interlayer spacing"
          title="Slide the cut along the surface normal, as a fraction of the interlayer spacing, to choose the termination"
        />
        {shift.toFixed(2)}
      </label>
      {summary && !tooMany ? (
        <span style={hintStyle} data-testid="builder-slab-preview">
          {`${summary.nAtoms} atoms, ${summary.thickness.toFixed(1)} Å thick`}
        </span>
      ) : (
        <Problem
          testId="builder-slab-preview"
          text={
            summary
              ? overLimit(summary.nAtoms)
              : (fieldProblem ??
                `Could not build a slab from this cell: ${slabProblem(snapshot, miller as Vec3)}.`)
          }
        />
      )}
    </div>
  );
}

/**
 * Why `slabPreview` gives no slab for this cell and (h k l): the reason the
 * summary line names after "Could not build a slab from this cell".
 */
export function slabProblem(snapshot: Snapshot, miller: Vec3): string {
  const box = snapshot.box ? Array.from(snapshot.box) : null;
  if (!box) return "the structure has no cell";
  if (!inverse3(box) || Math.abs(det3(box)) < 1e-9) {
    return "its vectors are coplanar (the cell has no volume)";
  }
  const basis = surfaceBasis(box, miller);
  if (!basis || !inverse3(basis)) {
    return `no surface cell spans the (${miller.join(" ")}) plane`;
  }
  return `the (${miller.join(" ")}) cut is degenerate in this cell`;
}
