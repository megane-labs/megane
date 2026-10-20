/**
 * The body of the History panel, a panel of its own under the Details panel
 * on the right of the view: Undo / Redo / Undo all, "Show original" (and,
 * while it is on, the way back to the edited structure), the edit list —
 * one row per Undo step, the current one marked, then the undone steps Redo
 * would bring back, dimmed; a click on a row (or Enter on it) jumps the
 * history to that step — and any warnings the edit engine raised replaying
 * the history. Pure UI over the Builder store.
 */

import type { CSSProperties } from "react";
import { editSteps } from "./store";
import { describeStep } from "./placement";
import { historyLock, jumpToStep, undoneSteps } from "./history";
import { buttonStyle, hintStyle, rowStyle, sectionStyle, toggleStyle } from "./styles";
import { useBuilderStoreApi, useScopedBuilderStore } from "./BuilderStores";

const listStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  color: "var(--megane-text-secondary, #475569)",
};

/** A history row: the whole line is the button that jumps to its step. */
function rowButtonStyle(current: boolean, undone: boolean, locked: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    font: "inherit",
    padding: "1px 6px",
    margin: "1px 0",
    borderRadius: 4,
    border: "1px solid transparent",
    background: current ? "rgba(59, 130, 246, 0.12)" : "transparent",
    color: current
      ? "var(--megane-primary-text, #2563eb)"
      : undone
        ? "var(--megane-text-faint, #94a3b8)"
        : "inherit",
    fontWeight: current ? 600 : 400,
    fontStyle: undone ? "italic" : "normal",
    cursor: locked || current ? "default" : "pointer",
  };
}

export function HistoryBody() {
  const api = useBuilderStoreApi();
  const source = useScopedBuilderStore((s) => s.source);
  const edits = useScopedBuilderStore((s) => s.edits);
  const redoStack = useScopedBuilderStore((s) => s.redoStack);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const preview = useScopedBuilderStore((s) => s.preview);
  const undo = useScopedBuilderStore((s) => s.undo);
  const redo = useScopedBuilderStore((s) => s.redo);
  const clearOps = useScopedBuilderStore((s) => s.clearOps);
  const setShowOriginal = useScopedBuilderStore((s) => s.setShowOriginal);
  const steps = editSteps(edits);
  const undone = undoneSteps(redoStack);
  const lock = historyLock({ preview, showOriginal });
  const undoOff = edits.length === 0 || !!lock;
  const redoOff = redoStack.length === 0 || !!lock;
  const originalOff = !source || (edits.length === 0 && !showOriginal);

  const row = (step: number, label: string, isUndone: boolean) => {
    // `step` is how many steps are applied once this row is the current one.
    const current = !isUndone && step === steps.length;
    return (
      <li key={`${isUndone ? "u" : "a"}${step}`}>
        <button
          type="button"
          data-testid={`builder-history-step-${step}`}
          aria-current={current ? "step" : undefined}
          disabled={!!lock}
          title={
            lock ??
            (current
              ? "The current step"
              : isUndone
                ? "Redo up to this step"
                : "Undo back to this step")
          }
          style={rowButtonStyle(current, isUndone, !!lock)}
          onClick={() => {
            if (!current) jumpToStep(api, step);
          }}
        >
          {label}
        </button>
      </li>
    );
  };

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
          style={buttonStyle("default", undoOff)}
          disabled={undoOff}
          title={lock && edits.length > 0 ? lock : undefined}
          onClick={() => undo()}
        >
          Undo
        </button>
        <button
          type="button"
          data-testid="builder-redo"
          style={buttonStyle("default", redoOff)}
          disabled={redoOff}
          title={lock && redoStack.length > 0 ? lock : undefined}
          onClick={() => redo()}
        >
          Redo
        </button>
        <button
          type="button"
          data-testid="builder-clear-ops"
          style={buttonStyle("danger", undoOff)}
          disabled={undoOff}
          title={lock && edits.length > 0 ? lock : "Undo every edit; Redo brings them back"}
          onClick={clearOps}
        >
          Undo all
        </button>
        <button
          type="button"
          data-testid="builder-show-original"
          aria-pressed={showOriginal}
          disabled={originalOff}
          style={{ ...toggleStyle(showOriginal, originalOff), fontFamily: "inherit" }}
          onClick={() => setShowOriginal(!showOriginal)}
          title="Preview the structure as loaded, without the edits"
        >
          Show original
        </button>
      </div>
      {steps.length > 0 || undone.length > 0 ? (
        <>
          {steps.length > 0 && (
            <ol data-testid="builder-op-list" style={listStyle}>
              {steps.map((step, i) => row(i + 1, describeStep(step), false))}
            </ol>
          )}
          {undone.length > 0 && (
            <ol
              data-testid="builder-undone-list"
              start={steps.length + 1}
              aria-label="Undone steps"
              style={{ ...listStyle, marginTop: steps.length > 0 ? -6 : 0 }}
            >
              {undone.map((step, i) => row(steps.length + i + 1, describeStep(step), true))}
            </ol>
          )}
        </>
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
