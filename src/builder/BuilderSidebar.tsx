/**
 * The Builder's side panel, an inspector in three layers:
 *
 *   Inspector — the structure (formula, counts, elements), or with a
 *               selection the selected atoms, what they measure and what can
 *               be done with them
 *   Cell      — the cell, read-only, and the offer to expand a file's symmetry
 *   History   — the operation list, undo / redo / clear, "show original"
 *
 * The tools are not here: they sit on the rail left of the view (`ToolRail`)
 * and their settings in the bar over it (`ContextBar`), which is also where
 * the Place tool's molecule library opens. Cell, supercell, slab, the Python
 * tools and inserting molecules are operations, so they live in the top bar's
 * Structure, Tools and Insert menus, as do the document's own actions (open,
 * new, save): each control appears exactly once. Pure UI over `useBuilderStore`; every edit goes through the store's
 * actions and the handlers installed by `useBuilderHandlers`.
 */

import { useBuilderStore, editSteps } from "./store";
import { describeStep } from "./placement";
import { Section } from "./Section";
import { Inspector } from "./Inspector";
import { CellCard } from "./crystal/CellCard";
import type { CrystalDialogKind } from "./crystal/CrystalDialog";
import { buttonStyle, hintStyle, rowStyle, sectionStyle, toggleStyle } from "./styles";

export {
  sectionStyle,
  sectionTitleStyle,
  hintStyle,
  inputStyle,
  chipStyle,
  buttonStyle,
} from "./styles";

export function BuilderSidebar({
  onOpenCrystal,
}: {
  /** Open one of the Structure menu's dialogs (the cell card's *Edit cell…*). */
  onOpenCrystal: (kind: CrystalDialogKind) => void;
}) {
  const source = useBuilderStore((s) => s.source);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const setShowOriginal = useBuilderStore((s) => s.setShowOriginal);

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

      <Inspector />
      <CellCard onOpen={onOpenCrystal} />
      <HistorySection defaultOpen={edits.length > 0} />
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
  const steps = editSteps(edits);

  return (
    <Section
      id="history"
      title="History"
      defaultOpen={defaultOpen}
      summary={
        <span data-testid="builder-op-count">
          {steps.length} edit{steps.length === 1 ? "" : "s"}
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
          {steps.map((step, i) => (
            <li key={i}>{describeStep(step)}</li>
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
