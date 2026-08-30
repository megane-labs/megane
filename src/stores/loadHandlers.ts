/**
 * Per-viewer routing for file drops on the Load* pipeline nodes.
 *
 * These used to be three module-level `let` slots, one per node module
 * (`Load{Structure,Trajectory,Vector}Node.tsx`), written by
 * `useNodeLoadHandlers`. With a single viewer that is fine. With two, the
 * second viewer's mount effect overwrites the first's handler — so a file
 * dropped on viewer A is parsed into viewer B's pipeline — and unmounting
 * *either* viewer sets the slot back to `null`, leaving the survivor's Load
 * nodes inert.
 *
 * Worse, it fails silently: `src/pipeline/defaults.ts` gives every default
 * graph the same hardcoded node ids, so the mis-routed
 * `setNodeSnapshot("loader-1", …)` lands on a real node in the wrong viewer
 * instead of throwing.
 *
 * So the slots move into a per-instance object carried by `MeganeStores`.
 * The module-global instance below backs the legacy
 * `set{Structure,Trajectory,Vector}LoadHandler` exports, which keeps every
 * provider-less host working unchanged.
 */

export type StructureLoadHandler = (nodeId: string, file: File) => void;
export type TrajectoryLoadHandler = (file: File) => void;
export type VectorLoadHandler = (file: File) => void;

export interface MeganeLoadHandlers {
  readonly structure: StructureLoadHandler | null;
  readonly trajectory: TrajectoryLoadHandler | null;
  readonly vector: VectorLoadHandler | null;
  setStructure(handler: StructureLoadHandler | null): void;
  setTrajectory(handler: TrajectoryLoadHandler | null): void;
  setVector(handler: VectorLoadHandler | null): void;
}

/** One viewer's worth of load-handler slots. */
export function createLoadHandlers(): MeganeLoadHandlers {
  return {
    structure: null,
    trajectory: null,
    vector: null,
    setStructure(handler) {
      (this as { structure: StructureLoadHandler | null }).structure = handler;
    },
    setTrajectory(handler) {
      (this as { trajectory: TrajectoryLoadHandler | null }).trajectory = handler;
    },
    setVector(handler) {
      (this as { vector: VectorLoadHandler | null }).vector = handler;
    },
  };
}

/**
 * Slots used when no `<MeganeProvider>` is mounted — the standalone webapp,
 * the VSCode webview, and every existing embedder.
 */
export const globalLoadHandlers: MeganeLoadHandlers = createLoadHandlers();
