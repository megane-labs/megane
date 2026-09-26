import { describe, it, expect } from "vitest";
import type { KeyboardEvent } from "react";
import { isImeComposing } from "@/utils/ime";

function ev(isComposing: boolean, keyCode: number): KeyboardEvent {
  return { nativeEvent: { isComposing }, keyCode } as unknown as KeyboardEvent;
}

describe("isImeComposing", () => {
  it("is true while the native event reports an active composition", () => {
    expect(isImeComposing(ev(true, 13))).toBe(true);
  });

  it("is true for Safari's post-compositionend keydown (keyCode 229)", () => {
    expect(isImeComposing(ev(false, 229))).toBe(true);
  });

  it("is false for a plain Enter", () => {
    expect(isImeComposing(ev(false, 13))).toBe(false);
  });
});
