import type { KeyboardEvent } from "react";

/**
 * True while an IME (Japanese, Chinese, Korean, ...) composition is in
 * progress. The Enter that confirms a conversion arrives as a regular
 * `keydown` with `key === "Enter"`, so Enter handlers must skip it or they
 * submit / commit a half-typed string.
 *
 * `isComposing` covers Chrome and Firefox; Safari fires the confirming
 * keydown *after* `compositionend` with `isComposing === false`, but still
 * reports the legacy IME keyCode 229.
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
