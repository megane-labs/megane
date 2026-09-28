/**
 * The Structure menu's dialogs: set the cell, centre the atoms with vacuum,
 * build a supercell, cut a slab. One operation per dialog, each a panel in
 * the corner of the 3D view so the view stays visible: while its fields make
 * a valid op, the view shows that op applied (`BuilderStore.setPreview`), and
 * *Apply* writes it as one undoable edit. Cancel, Escape or closing drops the
 * preview and leaves the document as it was.
 *
 * (Wrap, Remove cell and Expand symmetry take no parameters and run straight
 * from the menu; starting a bulk crystal is a new document and lives in the
 * "New structure" dialog.)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import { buttonStyle, hintStyle, inputStyle, rowStyle, toggleStyle } from "../styles";
import { boxToCellParams, cellParamsToBox, det3, type CellParams } from "../../crystal/cell";
import { slabPreview } from "../../crystal/transform";
import type { EditOp } from "../../pipeline/types";
import type { Snapshot } from "../../types";
import { newFragmentId } from "../library/fragment";
import { OVERLAY_INSET } from "../../components/overlayLayout";
import { floatingSurfaceStyle } from "../../components/toolbarStyles";
import { NumberField } from "./NumberField";
import { hasCellBox } from "./structure";

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

export function CrystalDialog({
  kind,
  onClose,
  right = OVERLAY_INSET,
}: {
  kind: CrystalDialogKind;
  onClose: () => void;
  /** Distance from the view's right edge (clear of the Details panel). */
  right?: number;
}) {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const pushOp = useBuilderStore((s) => s.pushOp);
  const setPreview = useBuilderStore((s) => s.setPreview);
  const previewing = useBuilderStore((s) => s.preview !== null);

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
  useEffect(() => () => useBuilderStore.getState().setPreview(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const canApply = !!draft.op && editable && (!spec.needsCell || hasCell);
  const apply = () => {
    if (!canApply) return;
    pushOp(committed(draft.op!));
    onClose();
  };

  return (
    <div
      data-testid="builder-crystal-dialog"
      data-kind={kind}
      role="dialog"
      aria-label={spec.title}
      style={{
        position: "absolute",
        top: OVERLAY_INSET,
        right,
        zIndex: 20,
        width: 320,
        maxWidth: `calc(100% - ${right + OVERLAY_INSET}px)`,
        maxHeight: `calc(100% - ${2 * OVERLAY_INSET}px)`,
        overflowY: "auto",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        fontSize: 13,
        ...floatingSurfaceStyle,
        color: "var(--megane-text, #1e293b)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ ...hintStyle, fontSize: 11 }}>Structure ›</span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{spec.title}</span>
      </div>

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
    </div>
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
  const op = useMemo<EditOp | null>(
    () =>
      valid
        ? { op: "set_cell", box: cellParamsToBox(params), scaleAtoms: scaleAtoms && hasCell }
        : null,
    [valid, params, scaleAtoms, hasCell],
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
  );
}

// ── Center with vacuum ──

function CenterForm({ nAtoms, onDraft }: { nAtoms: number; onDraft: OnDraft }) {
  const [vacuum, setVacuum] = useState(10);
  const [axes, setAxes] = useState<boolean[]>([false, false, true]);
  const op = useMemo<EditOp | null>(() => {
    const chosen = axes.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    return chosen.length > 0 && vacuum >= 0 ? { op: "center", axes: chosen, vacuum } : null;
  }, [axes, vacuum]);
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
    </div>
  );
}

// ── Supercell ──

const numStyle: React.CSSProperties = { ...inputStyle, width: 50 };

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
                aria-label={`Matrix row ${Math.floor(k / 3) + 1}, column ${(k % 3) + 1}`}
                value={v}
                onChange={(e) =>
                  setMatrix(matrix.map((x, i) => (i === k ? Number(e.target.value) : x)))
                }
                style={numStyle}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          data-testid="builder-supercell-advanced"
          aria-pressed={advanced}
          style={toggleStyle(advanced)}
          onClick={() => setAdvanced(!advanced)}
          title="Integer transformation matrix: rows are the new lattice vectors in units of the old ones"
        >
          Matrix
        </button>
      </div>
      <span style={hintStyle} data-testid="builder-supercell-preview">
        {valid
          ? `${images} image${images === 1 ? "" : "s"} → ${total} atoms`
          : tooMany
            ? overLimit(total)
            : "Invalid matrix"}
      </span>
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
  const valid = millerValid && layers >= 1 && vacuum >= 0;

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
            onChange={(v) => setMiller(miller.map((x, k) => (k === i ? v : x)))}
            testId={`builder-slab-${name}`}
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
      <span style={hintStyle} data-testid="builder-slab-preview">
        {summary
          ? tooMany
            ? overLimit(summary.nAtoms)
            : `${summary.nAtoms} atoms, ${summary.thickness.toFixed(1)} Å thick`
          : !millerValid
            ? "Miller indices must be integers, not all zero"
            : valid
              ? "Could not build a slab from this cell."
              : ""}
      </span>
    </div>
  );
}
