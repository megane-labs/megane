/**
 * The body of the History panel, a panel of its own under the Details panel
 * on the right of the view: the edit list, Undo / Redo / Clear all, "Show
 * original" (and, while it is on, the way back to the edited structure), and
 * any warnings the edit engine raised replaying the history. Pure UI over
 * `useBuilderStore`.
 */

import { useBuilderStore, editSteps } from "./store";
import { describeStep } from "./placement";
import { buttonStyle, hintStyle, rowStyle, sectionStyle, toggleStyle } from "./styles";

export function HistoryBody() {
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
    <div
      data-testid="builder-history"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 10,
        overflowY: "auto",
        fontSize: 13,
        color: "var(--megane-text, #1e293b)",
      }}
    >
      {source && showOriginal && (
        <div
          data-testid="builder-paused"
          style={{
            ...sectionStyle,
            gap: 6,
            background: "rgba(245, 158, 11, 0.12)",
            color: "var(--megane-warning-text, #b45309)",
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
      {edits.length > 0 ? (
        <ol
          data-testid="builder-op-list"
          style={{
            margin: 0,
            paddingLeft: 18,
            fontSize: 12,
            color: "var(--megane-text-secondary, #475569)",
          }}
        >
          {steps.map((step, i) => (
            <li key={i}>{describeStep(step)}</li>
          ))}
        </ol>
      ) : (
        <span style={hintStyle}>No edits yet.</span>
      )}
      {result && result.warnings.length > 0 && (
        <div
          data-testid="builder-warnings"
          style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
        >
          {result.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
