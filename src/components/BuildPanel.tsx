/**
 * Build panel — click-driven structure editing.
 *
 * Every click in the 3D view while this tab is active becomes one `EditOp`
 * appended to the pipeline's `edit` node (see `pipeline/editSync.ts`), so the
 * history is undoable, disable-able, saved with the pipeline and visible in
 * the Editor tab. The panel itself only holds UI state (tool, element,
 * selection); it never touches atom arrays directly.
 *
 * Atom indices arriving from the Viewport address the *rendered* structure.
 * They are translated to op refs (input index or created-atom id) through the
 * edit node's output provenance before an op is written.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useScopedPipelineStore,
  useScopedPipelineUIStore,
  useScopedBuildStore,
  usePipelineStoreApi,
  useBuildStoreApi,
} from "../stores/MeganeProvider";
import { applyEditOps } from "../pipeline/executors/edit";
import { findBuildEditNode, findPrimaryLoader } from "../pipeline/editSync";
import type { EditAtomRef, EditOp, EditParams, LoadStructureParams } from "../pipeline/types";
import type { BuildTool } from "../stores/useBuildStore";
import { getElementSymbol, getCovalentRadius } from "../constants";
import { STRUCTURE_EXPORT_FORMATS, exportSnapshot } from "../export/structureExport";
import type { StructureWriteFormat } from "../parsers/parseCore";
import type { Snapshot } from "../types";

const panelStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  fontSize: 13,
  color: "var(--megane-text, #1e293b)",
};

const sectionStyle: React.CSSProperties = {
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
  color: "#64748b",
};

const hintStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };

const selectStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#334155",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "3px 6px",
};

function chipStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: disabled ? "default" : "pointer",
    border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
    background: active ? "#2563eb" : "#f1f5f9",
    color: active ? "#fff" : disabled ? "#94a3b8" : "#334155",
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

let nextAtomSerial = 1;

/** Fresh id for an atom created from the panel. Unique within the page. */
export function newAtomId(): string {
  return `a${Date.now().toString(36)}-${nextAtomSerial++}`;
}

/**
 * Position for a new atom bonded to `anchor` (rendered index): one bond length
 * (sum of covalent radii) away, pointing away from the anchor's existing
 * neighbours so the new atom does not land on top of one. With no neighbours
 * it goes along +x.
 */
export function placeBondedAtom(
  snapshot: Snapshot,
  anchor: number,
  newElement: number,
): [number, number, number] {
  const ax = snapshot.positions[anchor * 3];
  const ay = snapshot.positions[anchor * 3 + 1];
  const az = snapshot.positions[anchor * 3 + 2];
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let n = 0;
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = snapshot.bonds[b * 2];
    const j = snapshot.bonds[b * 2 + 1];
    const other = i === anchor ? j : j === anchor ? i : -1;
    if (other < 0) continue;
    dx += snapshot.positions[other * 3] - ax;
    dy += snapshot.positions[other * 3 + 1] - ay;
    dz += snapshot.positions[other * 3 + 2] - az;
    n++;
  }
  let ux: number;
  let uy: number;
  let uz: number;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (n === 0 || len < 1e-6) {
    // No (or perfectly balanced) neighbours: pick +x, or +y when +x is taken.
    ux = 1;
    uy = 0;
    uz = 0;
    if (n > 0) {
      ux = 0;
      uy = 1;
    }
  } else {
    ux = -dx / len;
    uy = -dy / len;
    uz = -dz / len;
  }
  const length = getCovalentRadius(snapshot.elements[anchor]) + getCovalentRadius(newElement);
  return [ax + ux * length, ay + uy * length, az + uz * length];
}

export function BuildPanel() {
  const pipelineApi = usePipelineStoreApi();
  const buildApi = useBuildStoreApi();
  const rendered = useScopedPipelineStore(
    (s) => s.viewportState.particles[0]?.source ?? s.snapshot,
  );
  const nodes = useScopedPipelineStore((s) => s.nodes);
  const nodeErrors = useScopedPipelineStore((s) => s.nodeErrors);
  const atomLabels = useScopedPipelineStore((s) => s.atomLabels);
  const pushEditOp = useScopedPipelineStore((s) => s.pushEditOp);
  const undoEditOp = useScopedPipelineStore((s) => s.undoEditOp);
  const clearEditOps = useScopedPipelineStore((s) => s.clearEditOps);
  const setMode = useScopedPipelineUIStore((s) => s.setMode);

  const tool = useScopedBuildStore((s) => s.tool);
  const element = useScopedBuildStore((s) => s.element);
  const bondOrder = useScopedBuildStore((s) => s.bondOrder);
  const selected = useScopedBuildStore((s) => s.selected);
  const pendingBondAtom = useScopedBuildStore((s) => s.pendingBondAtom);
  const redoStack = useScopedBuildStore((s) => s.redoStack);
  const setTool = useScopedBuildStore((s) => s.setTool);
  const setElement = useScopedBuildStore((s) => s.setElement);
  const setBondOrder = useScopedBuildStore((s) => s.setBondOrder);
  const clearSelected = useScopedBuildStore((s) => s.clearSelected);
  const pushRedo = useScopedBuildStore((s) => s.pushRedo);
  const popRedo = useScopedBuildStore((s) => s.popRedo);
  const clearRedo = useScopedBuildStore((s) => s.clearRedo);

  const editNode = useMemo(() => findBuildEditNode(nodes), [nodes]);
  const ops: EditOp[] = useMemo(() => {
    const p = editNode?.data.params as EditParams | undefined;
    return p && Array.isArray(p.ops) ? p.ops : [];
  }, [editNode]);
  const loader = useMemo(() => findPrimaryLoader(nodes), [nodes]);
  const fileName = (loader?.data.params as LoadStructureParams | undefined)?.fileName ?? null;
  const editWarnings = editNode ? (nodeErrors[editNode.id] ?? []) : [];

  // The rendered atom count must match the edit node's output for rendered
  // indices to be translatable into op refs. Anything downstream that changes
  // the atom count (replicate, symmetry expansion) breaks that, so editing is
  // disabled with an explanation rather than writing ops against the wrong
  // atoms.
  const editOutput = useMemo(() => {
    const state = pipelineApi.getState();
    const loaderNode = findPrimaryLoader(state.nodes);
    const input = loaderNode
      ? (state.nodeSnapshots[loaderNode.id]?.snapshot ?? state.snapshot)
      : null;
    if (!input) return null;
    return applyEditOps(input, ops);
    // `rendered` changes identity on every pipeline execution, which is
    // exactly when the provenance must be recomputed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, rendered, pipelineApi]);

  const provenanceOk = !!rendered && !!editOutput && editOutput.snapshot.nAtoms === rendered.nAtoms;

  const refFor = useCallback(
    (renderedIndex: number): EditAtomRef | null => {
      if (!editOutput) return null;
      return editOutput.outputRefs[renderedIndex] ?? null;
    },
    [editOutput],
  );

  const commit = useCallback(
    (op: EditOp) => {
      pushEditOp(op);
      clearRedo();
    },
    [pushEditOp, clearRedo],
  );

  // ── Clicks from the 3D view ──
  const handlePick = useCallback(
    (info: {
      atomIndex: number | null;
      world: [number, number, number] | null;
      shiftKey: boolean;
    }) => {
      const state = buildApi.getState();
      const snapshot = pipelineApi.getState().viewportState.particles[0]?.source ?? null;
      if (!provenanceOk || !snapshot) return;
      const { atomIndex } = info;
      switch (state.tool) {
        case "select": {
          if (atomIndex === null) {
            if (!info.shiftKey) state.clearSelected();
            return;
          }
          if (info.shiftKey) state.toggleSelected(atomIndex);
          else state.setSelected([atomIndex]);
          return;
        }
        case "add": {
          const id = newAtomId();
          if (atomIndex !== null) {
            const ref = refFor(atomIndex);
            if (ref === null) return;
            commit({
              op: "add_atom",
              id,
              element: state.element,
              position: placeBondedAtom(snapshot, atomIndex, state.element),
              bondTo: ref,
              order: state.bondOrder,
            });
          } else if (info.world) {
            commit({ op: "add_atom", id, element: state.element, position: info.world });
          }
          return;
        }
        case "bond": {
          if (atomIndex === null) return;
          if (state.pendingBondAtom === null || state.pendingBondAtom === atomIndex) {
            state.setPendingBondAtom(atomIndex);
            return;
          }
          const a = refFor(state.pendingBondAtom);
          const b = refFor(atomIndex);
          state.setPendingBondAtom(null);
          if (a === null || b === null) return;
          commit({ op: "add_bond", a, b, order: state.bondOrder });
          return;
        }
        case "delete": {
          if (atomIndex === null) return;
          const ref = refFor(atomIndex);
          if (ref === null) return;
          state.clearSelected();
          commit({ op: "delete_atoms", atoms: [ref] });
          return;
        }
        case "element": {
          if (atomIndex === null) return;
          const ref = refFor(atomIndex);
          if (ref === null) return;
          commit({ op: "set_element", atoms: [ref], element: state.element });
          return;
        }
        case "move":
          // Moves are drags (see the drag handlers); a bare click selects.
          if (atomIndex !== null) state.setSelected([atomIndex]);
          return;
      }
    },
    [provenanceOk, refFor, commit, pipelineApi, buildApi],
  );

  // ── Drags from the 3D view (Move tool) ──
  const dragRefs = useRef<EditAtomRef[] | null>(null);
  const handleDragStart = useCallback(
    (atomIndex: number): boolean => {
      if (!provenanceOk) return false;
      const build = buildApi.getState();
      if (build.tool !== "move") return false;
      // Drag the whole selection when the grabbed atom is part of it.
      const group = build.selected.includes(atomIndex) ? build.selected : [atomIndex];
      const refs = group.map(refFor).filter((r): r is EditAtomRef => r !== null);
      if (refs.length === 0) return false;
      dragRefs.current = refs;
      pushEditOp({ op: "move_atoms", atoms: refs, delta: [0, 0, 0] });
      clearRedo();
      return true;
    },
    [provenanceOk, refFor, pushEditOp, clearRedo, buildApi],
  );
  const handleDragMove = useCallback(
    (delta: [number, number, number]) => {
      if (!dragRefs.current) return;
      pipelineApi
        .getState()
        .replaceLastEditOp({ op: "move_atoms", atoms: dragRefs.current, delta });
    },
    [pipelineApi],
  );
  const handleDragEnd = useCallback(() => {
    if (!dragRefs.current) return;
    dragRefs.current = null;
    // A drag that never moved leaves a zero-delta op behind; drop it.
    const last = findBuildEditNode(pipelineApi.getState().nodes);
    const p = last?.data.params as EditParams | undefined;
    const tail = p?.ops[p.ops.length - 1];
    if (tail && tail.op === "move_atoms" && tail.delta.every((d) => d === 0)) {
      pipelineApi.getState().undoEditOp();
    }
  }, [pipelineApi]);

  // Publish the handlers so MeganeViewer can hand them to the Viewport; the
  // two live in different subtrees, and the store is the bridge between them.
  const setHandlers = useScopedBuildStore((s) => s.setHandlers);
  useEffect(() => {
    setHandlers({
      pick: handlePick,
      dragStart: handleDragStart,
      dragMove: handleDragMove,
      dragEnd: handleDragEnd,
    });
    return () => setHandlers(null);
  }, [handlePick, handleDragStart, handleDragMove, handleDragEnd, setHandlers]);

  // ── Panel actions ──
  const handleUndo = () => {
    const op = undoEditOp();
    if (op) pushRedo(op);
    clearSelected();
  };
  const handleRedo = () => {
    const op = popRedo();
    if (op) pushEditOp(op);
  };
  const handleDeleteSelected = () => {
    const refs = selected.map(refFor).filter((r): r is EditAtomRef => r !== null);
    if (refs.length === 0) return;
    clearSelected();
    commit({ op: "delete_atoms", atoms: refs });
  };
  const handleSetElementSelected = () => {
    const refs = selected.map(refFor).filter((r): r is EditAtomRef => r !== null);
    if (refs.length === 0) return;
    commit({ op: "set_element", atoms: refs, element });
  };
  const handleExport = async (format: StructureWriteFormat) => {
    if (!rendered) return;
    await exportSnapshot(rendered, format, fileName, atomLabels);
  };

  if (!rendered) {
    return (
      <div style={panelStyle} data-testid="build-panel">
        <div style={hintStyle}>Load a structure to start building.</div>
      </div>
    );
  }

  const activeTool = TOOLS.find((t) => t.value === tool)!;

  return (
    <div style={panelStyle} data-testid="build-panel">
      {!provenanceOk && (
        <div
          data-testid="build-provenance-warning"
          style={{
            ...sectionStyle,
            background: "rgba(245, 158, 11, 0.12)",
            color: "#92400e",
            fontSize: 12,
          }}
        >
          Editing is paused: a node after Edit changes the atom count (Replicate or Symmetry
          expansion), so clicks cannot be mapped back to the loaded atoms. Set those nodes to 1×1×1
          / none while building.
        </div>
      )}

      <div style={sectionStyle}>
        <span style={sectionTitleStyle}>Tool</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TOOLS.map((t) => (
            <span
              key={t.value}
              role="button"
              data-testid={`build-tool-${t.value}`}
              aria-pressed={tool === t.value}
              style={chipStyle(tool === t.value)}
              onClick={() => setTool(t.value)}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div style={hintStyle} data-testid="build-tool-hint">
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
              data-testid={`build-element-${getElementSymbol(z)}`}
              style={chipStyle(element === z)}
              onClick={() => setElement(z)}
            >
              {getElementSymbol(z)}
            </span>
          ))}
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}>
            Z
            <input
              data-testid="build-element-z"
              type="number"
              min={1}
              max={118}
              value={element}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v) && v >= 1 && v <= 118) setElement(v);
              }}
              style={{ ...selectStyle, width: 56 }}
            />
          </label>
          <span style={hintStyle}>= {getElementSymbol(element)}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={hintStyle}>Bond order</span>
          <select
            data-testid="build-bond-order"
            value={bondOrder}
            onChange={(e) => setBondOrder(parseInt(e.target.value, 10))}
            style={selectStyle}
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
        <div style={hintStyle} data-testid="build-selected-count">
          {selected.length === 0
            ? "No atoms selected."
            : `${selected.length} atom${selected.length === 1 ? "" : "s"} selected.`}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span
            role="button"
            data-testid="build-delete-selected"
            style={chipStyle(false, selected.length === 0 || !provenanceOk)}
            onClick={selected.length > 0 && provenanceOk ? handleDeleteSelected : undefined}
          >
            Delete selected
          </span>
          <span
            role="button"
            data-testid="build-element-selected"
            style={chipStyle(false, selected.length === 0 || !provenanceOk)}
            onClick={selected.length > 0 && provenanceOk ? handleSetElementSelected : undefined}
          >
            Set to {getElementSymbol(element)}
          </span>
          <span
            role="button"
            data-testid="build-clear-selection"
            style={chipStyle(false, selected.length === 0)}
            onClick={selected.length > 0 ? clearSelected : undefined}
          >
            Clear
          </span>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={sectionTitleStyle}>History</span>
          <span style={hintStyle} data-testid="build-op-count">
            {ops.length} edit{ops.length === 1 ? "" : "s"}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span
            role="button"
            data-testid="build-undo"
            style={chipStyle(false, ops.length === 0)}
            onClick={ops.length > 0 ? handleUndo : undefined}
          >
            Undo
          </span>
          <span
            role="button"
            data-testid="build-redo"
            style={chipStyle(false, redoStack.length === 0)}
            onClick={redoStack.length > 0 ? handleRedo : undefined}
          >
            Redo
          </span>
          <span
            role="button"
            data-testid="build-clear-ops"
            style={chipStyle(false, ops.length === 0)}
            onClick={
              ops.length > 0
                ? () => {
                    clearEditOps();
                    clearRedo();
                    clearSelected();
                  }
                : undefined
            }
          >
            Clear all
          </span>
          <span
            role="button"
            data-testid="build-open-editor"
            style={chipStyle(false)}
            onClick={() => setMode("editor")}
          >
            Show in Editor
          </span>
        </div>
        {ops.length > 0 && (
          <ol
            data-testid="build-op-list"
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: "#475569",
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {ops.map((op, i) => (
              <li key={i}>{describeOp(op)}</li>
            ))}
          </ol>
        )}
        {editWarnings.length > 0 && (
          <div data-testid="build-warnings" style={{ ...hintStyle, color: "#b45309" }}>
            {editWarnings.map((w, i) => (
              <div key={i}>{w.message}</div>
            ))}
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <span style={sectionTitleStyle}>Export</span>
        <div style={hintStyle}>
          {rendered.nAtoms} atoms, {rendered.nBonds} bonds as shown.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {STRUCTURE_EXPORT_FORMATS.map((f) => (
            <span
              key={f.value}
              role="button"
              data-testid={`build-export-${f.value}`}
              style={chipStyle(false)}
              onClick={() => void handleExport(f.value)}
            >
              Save {f.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One-line description of an op for the history list. */
export function describeOp(op: EditOp): string {
  const ref = (r: EditAtomRef) => (typeof r === "number" ? `#${r}` : r);
  switch (op.op) {
    case "add_atom":
      return `Add ${getElementSymbol(op.element)}${op.bondTo !== undefined ? ` bonded to ${ref(op.bondTo)}` : ""}`;
    case "delete_atoms":
      return `Delete ${op.atoms.length} atom${op.atoms.length === 1 ? "" : "s"}`;
    case "move_atoms":
      return `Move ${op.atoms.length} atom${op.atoms.length === 1 ? "" : "s"} by (${op.delta.map((d) => d.toFixed(2)).join(", ")}) Å`;
    case "set_element":
      return `Set ${op.atoms.length} atom${op.atoms.length === 1 ? "" : "s"} to ${getElementSymbol(op.element)}`;
    case "add_bond":
      return `Bond ${ref(op.a)} – ${ref(op.b)}${op.order && op.order !== 1 ? ` (order ${op.order})` : ""}`;
    case "delete_bond":
      return `Remove bond ${ref(op.a)} – ${ref(op.b)}`;
    case "add_fragment":
      return `Add fragment "${op.id}" (${op.elements.length} atoms)`;
    case "set_cell":
      return op.box ? "Set cell" : "Remove cell";
    default:
      return String((op as { op: unknown }).op);
  }
}
