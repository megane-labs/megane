/**
 * Test helpers for the impostor meshes' RGBA8 instance colors
 * (`COLOR_STRIDE` bytes per instance, alpha unused).
 */
import { COLOR_STRIDE } from "@/renderer/instanceCapacity";

/**
 * `toBeCloseTo` digits that a color stored as one byte per channel still
 * meets: quantizing to 1/255 moves a channel by at most 1/510 < 0.005.
 */
export const BYTE_DIGITS = 2;

/** The [0, 1] RGB color of instance `i` in an RGBA8 color buffer. */
export function rgbAt(buf: ArrayLike<number>, i: number): [number, number, number] {
  const o = i * COLOR_STRIDE;
  return [buf[o] / 255, buf[o + 1] / 255, buf[o + 2] / 255];
}

/** Pack [0, 1] RGB triples into an RGBA8 buffer, as the atom mesh stores them. */
export function rgba8(rgb: number[]): Uint8ClampedArray {
  const n = rgb.length / 3;
  const out = new Uint8ClampedArray(n * COLOR_STRIDE);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[i * COLOR_STRIDE + c] = rgb[i * 3 + c] * 255;
  }
  return out;
}
