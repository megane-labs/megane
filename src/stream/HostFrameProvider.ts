import type { Frame, TrajectoryMeta } from "../types";
import { frameBytes, type FrameProvider } from "../pipeline/types";

/**
 * The trajectory of a host that delivers frames itself, as a pipeline
 * `FrameProvider`.
 *
 * The Jupyter widget gets each frame from the kernel (or reads it from a
 * trajectory embedded in the widget state) when `frame_index` changes; the
 * pipeline never sees the trajectory file. Handing the frame straight to the
 * renderer skipped every node between the trajectory and the viewport, so a
 * `Wrap` or `Replicate` node changed the structure but not the frames played
 * over it. This provider is the pipeline's `load_trajectory` source instead:
 * the host puts the frame it was given in with `setFrame`, and reads it back
 * through the viewport's provider chain, mapped by every node on the way.
 *
 * It holds that one frame only: `getFrame` answers it for its own `frameId`
 * and `null` for any other index, like a stream whose frame has not arrived.
 */
export class HostFrameProvider implements FrameProvider {
  readonly kind = "stream" as const;
  readonly meta: TrajectoryMeta;
  private frame: Frame | null = null;

  constructor(meta: TrajectoryMeta) {
    this.meta = meta;
  }

  /** The frame the host was last given (`null`: none). */
  setFrame(frame: Frame | null): void {
    this.frame = frame;
  }

  getFrame(index: number): Frame | null {
    return this.frame !== null && this.frame.frameId === index ? this.frame : null;
  }

  heldBytes(): number {
    return this.frame ? frameBytes(this.frame) : 0;
  }
}
