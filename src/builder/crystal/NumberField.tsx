/**
 * A labelled numeric input for the crystal forms.
 *
 * The field keeps what the user types as text and hands the form a number
 * only when the text is one: an emptied or half-typed field ("", "-", "1e")
 * reports NaN instead of snapping to 0, so the form can say what is wrong
 * while the text stays as typed. A value the form sets from outside (an
 * example, the document changing) replaces the text. Below `min` (or not
 * whole when `integer`), the field is marked invalid; the form decides
 * whether that blocks Apply and says why (`numberProblem`).
 */

import { useEffect, useState } from "react";
import { hintStyle, inputStyle } from "../styles";

const numStyle: React.CSSProperties = { ...inputStyle, width: 58 };
const invalidStyle: React.CSSProperties = {
  borderColor: "var(--megane-danger-text, #b91c1c)",
  outlineColor: "var(--megane-danger-text, #b91c1c)",
};

/** The number `text` spells, or NaN (blank, partial or not a number). */
export function parseNumber(text: string): number {
  const t = text.trim();
  if (t === "") return Number.NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : Number.NaN;
}

export interface NumberRule {
  min?: number;
  /** `min` itself is not allowed. */
  exclusiveMin?: boolean;
  max?: number;
  exclusiveMax?: boolean;
  integer?: boolean;
  /** Unit for the message ("Å", "°"). */
  unit?: string;
}

/** What is wrong with `value` for `rule`, as a sentence about `label`; null when it is fine. */
export function numberProblem(label: string, value: number, rule: NumberRule = {}): string | null {
  const unit = rule.unit ? (rule.unit === "°" ? "°" : ` ${rule.unit}`) : "";
  if (!Number.isFinite(value)) return `${label} needs a number.`;
  if (rule.integer && !Number.isInteger(value)) return `${label} must be a whole number.`;
  if (rule.min !== undefined) {
    if (rule.exclusiveMin ? value <= rule.min : value < rule.min) {
      return rule.exclusiveMin && rule.min === 0
        ? `${label} must be greater than 0${unit}.`
        : `${label} must be ${rule.exclusiveMin ? "greater than" : "at least"} ${rule.min}${unit}.`;
    }
  }
  if (rule.max !== undefined) {
    if (rule.exclusiveMax ? value >= rule.max : value > rule.max) {
      return `${label} must be ${rule.exclusiveMax ? "less than" : "at most"} ${rule.max}${unit}.`;
    }
  }
  return null;
}

/** How a number shows in the field: as typed by `String`, blank for NaN. */
function format(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

export function NumberField({
  label,
  value,
  onChange,
  testId,
  step = 1,
  min,
  integer = false,
  unit,
  width,
  title,
  ariaLabel,
}: {
  label: string;
  value: number;
  /** The typed number, or NaN while the text is not one. */
  onChange: (v: number) => void;
  testId: string;
  step?: number;
  /** Values below are marked invalid (the form still decides whether that blocks Apply). */
  min?: number;
  /** Fractions are marked invalid. */
  integer?: boolean;
  /** Shown after the field ("Å", "°"). */
  unit?: string;
  width?: number;
  title?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(() => format(value));
  // Follow a value set from outside; an invalid draft (NaN) keeps its text.
  useEffect(() => {
    if (Number.isFinite(value) && parseNumber(text) !== value) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const parsed = parseNumber(text);
  const invalid =
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    (min !== undefined && parsed < min);
  const base = width ? { ...numStyle, width } : numStyle;

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 3 }} title={title}>
      {label && <span style={hintStyle}>{label}</span>}
      <input
        type="text"
        inputMode={integer && (min ?? -1) >= 0 ? "numeric" : "decimal"}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseNumber(e.target.value));
        }}
        onKeyDown={(e) => {
          // The arrow keys still step the value, as a number input's do.
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          const current = Number.isFinite(parsed) ? parsed : (min ?? 0);
          let next = current + (e.key === "ArrowUp" ? step : -step);
          if (min !== undefined && next < min) next = min;
          next = Number(next.toFixed(6));
          e.preventDefault();
          setText(format(next));
          onChange(next);
        }}
        style={invalid ? { ...base, ...invalidStyle } : base}
      />
      {unit && <span style={hintStyle}>{unit}</span>}
    </label>
  );
}
