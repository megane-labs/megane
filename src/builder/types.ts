/**
 * Types shared between the Builder app and the 3D view it edits through.
 *
 * `Viewport` (src/components) knows nothing about the Builder's store; it
 * only calls the handlers the app installs, so the contract lives here.
 */

export type BuildTool = "select" | "add" | "bond" | "delete" | "move" | "element";

/** What the Viewport reports for a left click while building. */
export interface BuildPickInfo {
  /** Rendered atom index under the pointer, or null for empty space. */
  atomIndex: number | null;
  /** World point under the pointer at the pivot's depth (empty-space clicks). */
  world: [number, number, number] | null;
  shiftKey: boolean;
}

/** Callbacks the Builder installs for the 3D view. */
export interface BuildHandlers {
  pick: (info: BuildPickInfo) => void;
  /** Return true to start dragging `atomIndex` (the Move tool). */
  dragStart: (atomIndex: number) => boolean;
  /** Cumulative world displacement since the drag started. */
  dragMove: (delta: [number, number, number]) => void;
  dragEnd: () => void;
}
