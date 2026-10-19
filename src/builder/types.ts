/**
 * Types shared between the Builder app and the 3D view it edits through.
 *
 * `Viewport` (src/components) knows nothing about the Builder's store; it
 * only calls the handlers the app installs, so the contract lives here.
 */

/**
 * `place` stamps the library molecule chosen in its settings
 * (`BuilderStore.placeSource`) wherever the user clicks empty space.
 */
export type BuildTool = "select" | "add" | "bond" | "delete" | "move" | "element" | "place";

type Vec3 = [number, number, number];

/** The modifier keys held with a press, a click or a double-click. */
export interface BuildModifiers {
  shiftKey: boolean;
  /** Ctrl, or ⌘ on a Mac. */
  mod: boolean;
  altKey: boolean;
}

/** What the Viewport reports for a left click while building. */
export interface BuildPickInfo {
  /** Rendered atom index under the pointer, or null for empty space. */
  atomIndex: number | null;
  /** World point under the pointer at the pivot's depth (empty-space clicks). */
  world: [number, number, number] | null;
  shiftKey: boolean;
  /** Ctrl / ⌘ held. */
  mod?: boolean;
}

/**
 * What a left press turns into once the pointer moves: `move` drags atoms
 * (`dragStart` …), `box` draws a rubber band (`boxSelect`), `camera` leaves
 * the press to the camera controls. A press released without moving is a
 * click (`pick`) whatever the answer was.
 */
export type BuildPressAction = "move" | "box" | "camera";

/** How a rubber band changes the selection: Shift adds, Ctrl / ⌘ removes. */
export type BuildBoxMode = "replace" | "add" | "subtract";

/**
 * A drag in progress, as the view sees it: where the pointer went (viewport
 * pixels, from the press), the camera's axes in world space, and how far one
 * pixel is at the grabbed atom's depth. The handler turns it into atom
 * displacements; it does not touch the renderer.
 */
export interface BuildDragGesture {
  from: [number, number];
  to: [number, number];
  /** Screen right, screen up, and toward the camera (unit vectors, world space). */
  right: Vec3;
  up: Vec3;
  toCamera: Vec3;
  /** World length of one pixel at the grabbed atom's depth. */
  worldPerPixel: number;
  /** Viewport pixels of a world point. */
  project: (p: Vec3) => [number, number];
}

/** Callbacks the Builder installs for the 3D view. */
export interface BuildHandlers {
  pick: (info: BuildPickInfo) => void;
  /** What a left press on `atomIndex` (null: empty space) does if the pointer moves. */
  pressAction: (atomIndex: number | null, mods: BuildModifiers) => BuildPressAction;
  /** Start dragging `atomIndex` (and the selection it is in); false refuses. */
  dragStart: (atomIndex: number, mods: BuildModifiers) => boolean;
  /** The pointer moved: the whole gesture since the press. */
  dragMove: (gesture: BuildDragGesture) => void;
  dragEnd: () => void;
  /** The rendered atoms inside a finished rubber band. */
  boxSelect: (indices: number[], mode: BuildBoxMode) => void;
  /** A double-click on an atom; true when handled (the camera then keeps its pivot). */
  doubleClick: (atomIndex: number, mods: BuildModifiers) => boolean;
}
