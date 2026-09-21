/** A labelled numeric input for the crystal forms. */

import { hintStyle, inputStyle } from "../styles";

const numStyle: React.CSSProperties = { ...inputStyle, width: 58 };

export function NumberField({
  label,
  value,
  onChange,
  testId,
  step = 1,
  min,
  width,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testId: string;
  step?: number;
  min?: number;
  width?: number;
  title?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 3 }} title={title}>
      {label && <span style={hintStyle}>{label}</span>}
      <input
        type="number"
        data-testid={testId}
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        style={width ? { ...numStyle, width } : numStyle}
      />
    </label>
  );
}
