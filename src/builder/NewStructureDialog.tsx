/**
 * "New structure": the one place a document starts from scratch, as an
 * empty cubic cell or a bulk crystal — a form in the Details panel, opened
 * from File › New. Both replace whatever is open, which the form says once
 * instead of every tab repeating it; with unsaved edits open, `confirmReplace`
 * asks first, and a "no" keeps the form open and the document as it was.
 */

import { useRef, useState, type KeyboardEvent } from "react";
import { DetailForm } from "./DetailForm";
import type { BulkSpec } from "../crystal/bulk";
import { BulkForm } from "./crystal/BulkForm";
import { NumberField } from "./crystal/NumberField";
import { buttonStyle, hintStyle, rowStyle, segmentGroupStyle, segmentStyle } from "./styles";

/** Default edge of a new cell, in Å. */
export const DEFAULT_NEW_CELL_EDGE = 10;

export type NewStructureKind = "cell" | "bulk";

const KINDS: { value: NewStructureKind; label: string }[] = [
  { value: "cell", label: "Empty cell" },
  { value: "bulk", label: "Bulk crystal" },
];

export interface NewStructureDialogProps {
  initialKind?: NewStructureKind;
  /** Whether a document is open (the dialog then warns that it is replaced). */
  hasDocument: boolean;
  onNewCell: (edge: number) => void;
  onNewBulk: (spec: BulkSpec) => void;
  onClose: () => void;
  /**
   * Asked before a new structure replaces the open one: true (or a promise
   * of true) goes ahead. Without it, the form goes ahead at once.
   */
  confirmReplace?: () => boolean | Promise<boolean>;
}

export function NewStructureDialog({
  initialKind = "cell",
  hasDocument,
  onNewCell,
  onNewBulk,
  onClose,
  confirmReplace,
}: NewStructureDialogProps) {
  const [kind, setKind] = useState<NewStructureKind>(initialKind);
  const [edge, setEdge] = useState(DEFAULT_NEW_CELL_EDGE);
  const [error, setError] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const edgeValid = Number.isFinite(edge) && edge > 0;

  const pick = (next: NewStructureKind) => {
    setKind(next);
    setError(null);
  };

  // Arrow keys, Home and End move between the tabs, as in any tab list.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = KINDS.length - 1;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    pick(KINDS[to].value);
    tabRefs.current[to]?.focus();
  };

  /**
   * Run `create` once replacing the open structure is agreed. A synchronous
   * answer runs it at once, so a throw reaches the caller (BulkForm reports
   * it); after an asked question, a throw is reported here.
   */
  const proceed = (create: () => void) => {
    const ok = confirmReplace ? confirmReplace() : true;
    if (ok === true) create();
    else if (ok !== false) {
      void ok.then((yes) => {
        if (!yes) return;
        try {
          create();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    }
  };

  return (
    <DetailForm
      testId="builder-new-dialog"
      title="New structure"
      onClose={onClose}
      closeTestId="builder-new-close"
    >
      <div style={segmentGroupStyle} role="tablist" aria-label="Kind of structure">
        {KINDS.map((k, i) => (
          <button
            key={k.value}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={kind === k.value}
            tabIndex={kind === k.value ? 0 : -1}
            data-testid={`builder-new-kind-${k.value}`}
            style={{ ...segmentStyle(kind === k.value), fontFamily: "inherit" }}
            onClick={() => pick(k.value)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {k.label}
          </button>
        ))}
      </div>
      {kind === "cell" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={hintStyle}>
            An atom-less cubic cell to build into. The cell is what the camera frames and what free
            atoms are placed against.
          </div>
          <div style={rowStyle}>
            <NumberField
              label="Edge"
              value={edge}
              onChange={setEdge}
              testId="builder-new-cell-edge"
              min={0.1}
              width={64}
            />
            <span style={hintStyle}>Å</span>
            <button
              type="button"
              data-testid="builder-new-cell"
              style={buttonStyle("primary", !edgeValid)}
              disabled={!edgeValid}
              onClick={() =>
                proceed(() => {
                  onNewCell(edge);
                  onClose();
                })
              }
            >
              Create empty cell
            </button>
          </div>
        </div>
      ) : (
        <BulkForm
          onCreate={(spec) =>
            proceed(() => {
              onNewBulk(spec);
              onClose();
            })
          }
          onError={setError}
        />
      )}
      {error && (
        <div
          data-testid="builder-new-error"
          role="alert"
          style={{ ...hintStyle, color: "var(--megane-danger-text, #b91c1c)" }}
        >
          {error}
        </div>
      )}
      {hasDocument && (
        <div
          style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
          data-testid="builder-new-replaces"
        >
          This replaces the open structure and its history.
        </div>
      )}
    </DetailForm>
  );
}
