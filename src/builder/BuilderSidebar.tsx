/**
 * The Builder's side panel, in five layers:
 *
 *   Selection    — what can be done with the selected atoms (only while there are some)
 *   Library      — molecules to drop into the document
 *   Crystal      — cell, supercell, slab, symmetry (edits of the open structure)
 *   Python tools — buttons backed by an MCP tool server (liquid box, polymer, …)
 *   History      — the operation list, undo / redo / clear, "show original"
 *
 * The tools are not here: they sit on the rail left of the view (`ToolRail`)
 * and their settings in the bar over it (`ContextBar`). Document-level actions
 * (open, new, save) live in the top bar, so each control appears exactly
 * once. Pure UI over `useBuilderStore`; every edit goes through the store's
 * actions and the handlers installed by `useBuilderHandlers`.
 */

import { useBuilderStore, canEdit } from "./store";
import { describeOp } from "./placement";
import { Section } from "./Section";
import type { EditAtomRef } from "../pipeline/types";
import { getElementSymbol } from "../constants";
import { LibrarySection } from "./library/LibrarySection";
import { CrystalSection } from "./crystal/CrystalSection";
import { ToolsSection } from "./tools/ToolsSection";
import {
  buttonStyle,
  hintStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
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

export function BuilderSidebar() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const selected = useBuilderStore((s) => s.selected);
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

      {selected.length > 0 && <SelectionSection editable={editable} />}
      <LibrarySection />
      <CrystalSection />
      <ToolsSection />
      <HistorySection defaultOpen={edits.length > 0} />
    </div>
  );
}

/** What can be done with the current selection, shown only while there is one. */
function SelectionSection({ editable }: { editable: boolean }) {
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
      style={{ ...sectionStyle, borderColor: "rgba(37, 99, 235, 0.35)" }}
      data-testid="builder-selection"
    >
      <span style={sectionTitleStyle}>Selection</span>
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
