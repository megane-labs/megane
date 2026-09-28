/**
 * The one-time offer to expand a file's symmetry operations, shown in the
 * Details panel right after opening a CIF that lists them (the Structure
 * menu's *Expand symmetry* does the same at any time). Setting and editing
 * the cell is the Structure menu's *Set cell…*; the cell itself is on the
 * info line over the view.
 */

import { useBuilderStore, canEdit } from "../store";
import { buttonStyle, hintStyle, rowStyle } from "../styles";
import { newFragmentId } from "../library/fragment";
import { symmetryOpsAvailable } from "./structure";

export function SymmetryOffer() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const pushOp = useBuilderStore((s) => s.pushOp);

  const symOps = symmetryOpsAvailable(source, edits);
  if (symOps === 0) return null;
  const editable = canEdit({ source, result, showOriginal });

  return (
    <div
      style={{
        ...rowStyle,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(59, 130, 246, 0.08)",
      }}
      data-testid="builder-crystal-symmetry"
    >
      <span style={hintStyle}>
        This file lists {symOps} symmetry operation{symOps === 1 ? "" : "s"} for its asymmetric
        unit.
      </span>
      <button
        type="button"
        data-testid="builder-crystal-expand-symmetry"
        style={buttonStyle("primary", !editable)}
        disabled={!editable}
        onClick={() => pushOp({ op: "expand_symmetry", id: newFragmentId("symmetry") })}
        title="Fill the unit cell with the symmetry-equivalent atoms (as the viewer's Symmetry node does)"
      >
        Expand symmetry
      </button>
    </div>
  );
}
