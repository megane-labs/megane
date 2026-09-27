/**
 * The Structure menu: every edit of the cell and the crystal in one list.
 * Items that take parameters open a `CrystalDialog`; Wrap, Remove cell and
 * Expand symmetry run at once. Each is disabled, not hidden, when the
 * document cannot take it, so the menu always reads the same.
 */

import type { MenuItem } from "../Menu";
import type { EditOp } from "../../pipeline/types";
import { newFragmentId } from "../library/fragment";
import type { CrystalDialogKind } from "./CrystalDialog";

export interface StructureMenuState {
  hasDocument: boolean;
  /** Clicks may write ops (a document is open and the original is not shown). */
  editable: boolean;
  hasCell: boolean;
  nAtoms: number;
  /** Symmetry operations still to expand (`symmetryOpsAvailable`). */
  symmetryOps: number;
}

export function structureMenuItems(
  state: StructureMenuState,
  open: (kind: CrystalDialogKind) => void,
  apply: (op: EditOp) => void,
): MenuItem[] {
  const { editable, hasCell, nAtoms, symmetryOps } = state;
  const withCell = editable && hasCell;
  return [
    { caption: "Cell" },
    {
      label: hasCell ? "Edit cell…" : "Set cell…",
      testId: "builder-structure-cell",
      disabled: !editable,
      onSelect: () => open("cell"),
    },
    {
      label: "Wrap atoms into cell",
      testId: "builder-cell-wrap",
      disabled: !withCell || nAtoms === 0,
      title: "Fold every atom back into the cell",
      onSelect: () => apply({ op: "wrap" }),
    },
    {
      label: "Center with vacuum…",
      testId: "builder-structure-center",
      disabled: !withCell,
      onSelect: () => open("center"),
    },
    {
      label: "Remove cell",
      testId: "builder-cell-remove",
      disabled: !withCell,
      onSelect: () => apply({ op: "set_cell", box: null }),
    },
    { separator: true },
    { caption: "Crystal" },
    {
      label: "Supercell…",
      testId: "builder-structure-supercell",
      disabled: !withCell,
      onSelect: () => open("supercell"),
    },
    {
      label: "Cut slab…",
      testId: "builder-structure-slab",
      disabled: !withCell,
      onSelect: () => open("slab"),
    },
    {
      label:
        symmetryOps > 0
          ? `Expand symmetry (${symmetryOps} operation${symmetryOps === 1 ? "" : "s"})`
          : "Expand symmetry",
      testId: "builder-structure-expand-symmetry",
      disabled: !editable || symmetryOps === 0,
      title:
        symmetryOps > 0
          ? "Fill the unit cell with the symmetry-equivalent atoms"
          : "Only for a file that lists symmetry operations, before the cell is changed",
      onSelect: () => apply({ op: "expand_symmetry", id: newFragmentId("symmetry") }),
    },
  ];
}
