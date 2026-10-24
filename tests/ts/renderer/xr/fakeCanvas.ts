/**
 * A stand-in 2D context for the headset's canvas textures. jsdom has no
 * canvas backend (getContext reports "not implemented" and returns null), so
 * tests that want to see what the panel and labels draw stub it with this:
 * every method is a spy, and `measureText` reports 10 px per character.
 */

import { vi } from "vitest";

export type FakeContext2D = CanvasRenderingContext2D & {
  /** Every `fillText` call's text, in order. */
  texts: string[];
};

export function fakeContext2D(): FakeContext2D {
  const texts: string[] = [];
  const methods = [
    "arc",
    "arcTo",
    "beginPath",
    "clearRect",
    "closePath",
    "fill",
    "fillRect",
    "lineTo",
    "moveTo",
    "rect",
    "restore",
    "save",
    "stroke",
    "strokeText",
  ];
  const ctx: Record<string, unknown> = { texts };
  for (const name of methods) ctx[name] = vi.fn();
  ctx.fillText = vi.fn((text: string) => texts.push(text));
  ctx.measureText = vi.fn((text: string) => ({ width: text.length * 10 }));
  return ctx as unknown as FakeContext2D;
}

/**
 * Make every canvas hand out a fake 2D context (one per canvas). Returns the
 * contexts handed out so far; restore with `vi.restoreAllMocks()`.
 */
export function stubCanvas2D(): FakeContext2D[] {
  const handed: FakeContext2D[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const self = this as HTMLCanvasElement & { __fake?: FakeContext2D };
    if (!self.__fake) {
      self.__fake = fakeContext2D();
      handed.push(self.__fake);
    }
    return self.__fake;
  } as unknown as HTMLCanvasElement["getContext"]);
  return handed;
}
