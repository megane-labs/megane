/**
 * Per-atom vector channels (velocities, forces, momenta) of a file whose
 * frames stream lazily: they arrive with each decoded frame, so they are
 * collected here and offered to the load_vector node UI as they come in —
 * every channel the file carries, as an eager parse offers them at once.
 */

import type { VectorChannel } from "../types";
import type { LazyFrameProvider } from "./LazyFrameProvider";

/** How long decoded frames are batched before the channels are offered again, ms. */
export const VECTOR_OFFER_DELAY_MS = 200;

/**
 * Collect `names` (the channels each decoded frame of `provider` carries,
 * concatenated in this order, `nAtoms * 3` values each) and hand them to
 * `offer`, frames in order, batched every `delayMs` so the pipeline does not
 * re-run per frame. `seed` holds frames already known (a structure's frame
 * 0), offered right away; a seeded channel the frames do not carry stays as
 * seeded (an extXYZ property only frame 0 declares, as the eager parse keeps
 * it).
 */
export function streamVectorChannels(
  provider: Pick<LazyFrameProvider, "setOnVectors">,
  names: readonly string[],
  nAtoms: number,
  offer: (channels: VectorChannel[]) => void,
  seed: readonly VectorChannel[] = [],
  delayMs = VECTOR_OFFER_DELAY_MS,
): void {
  const all = [...names, ...seed.map((c) => c.name).filter((n) => !names.includes(n))];
  if (all.length === 0) return;
  const stride = nAtoms * 3;
  const collected = all.map(
    (name) =>
      new Map<number, Float32Array>(
        (seed.find((c) => c.name === name)?.frames ?? []).map((f) => [f.frame, f.vectors]),
      ),
  );
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    offer(
      all.map((name, c) => ({
        name,
        frames: [...collected[c].entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([frame, vectors]) => ({ frame, vectors })),
      })),
    );
  };
  if (names.length > 0) {
    provider.setOnVectors((frameId, vectors) => {
      names.forEach((_, c) => {
        if (vectors.length >= (c + 1) * stride) {
          collected[c].set(frameId, vectors.slice(c * stride, (c + 1) * stride));
        }
      });
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, delayMs);
      }
    });
  }
  if (collected.some((frames) => frames.size > 0)) flush();
}
