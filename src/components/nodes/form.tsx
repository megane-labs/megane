/**
 * Layout pieces for node forms in the properties pane (styles in
 * `formStyles.ts`): a {@link Field} row of label and control, a
 * {@link SliderField}, a titled {@link Section}, and the {@link FileDrop} box
 * the loader nodes share.
 */

import type { ReactNode } from "react";
import {
  emptyFileStyle,
  fieldControlStyle,
  fieldLabelStyle,
  fieldStyle,
  formStackStyle,
  nodeButtonStyle,
  nodeFileNameStyle,
  sectionTitleStyle,
  sliderStyle,
  sliderValueStyle,
} from "./formStyles";

/** A node form's rows, stacked with the shared gap. */
export function FormStack({ children }: { children: ReactNode }) {
  return <div style={formStackStyle}>{children}</div>;
}

/**
 * One row: `label` on the left, `children` on the right. A plain row is a
 * `<label>`, so a click on the text reaches its control; a row holding
 * several buttons (a segmented choice) passes `group` and becomes a labelled
 * group instead, since a `<label>` would forward the click to its first button.
 */
export function Field({
  label,
  group = false,
  children,
}: {
  label: ReactNode;
  group?: boolean;
  children: ReactNode;
}) {
  if (group) {
    return (
      <div
        role="group"
        aria-label={typeof label === "string" ? label : undefined}
        style={fieldStyle}
      >
        <span style={fieldLabelStyle}>{label}</span>
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    );
  }
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <span style={fieldControlStyle}>{children}</span>
    </label>
  );
}

/** A slider row with its value printed after it. */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <Field label={label}>
      <input
        type="range"
        className="nodrag"
        data-testid={testId}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={sliderStyle}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span style={sliderValueStyle}>{format(value)}</span>
    </Field>
  );
}

/** A small uppercase title over a group of rows. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={sectionTitleStyle}>{title}</span>
      {children}
    </div>
  );
}

/**
 * A loader's file: the open file's name (or `emptyText`), any facts about it,
 * and the button that opens the file dialog, in a dashed box that also takes
 * a dropped file.
 */
export function FileDrop({
  fileName,
  emptyText,
  buttonLabel,
  onPick,
  onDrop,
  onDragOver,
  nameTestId,
  testId,
  fileInput,
  remote,
  children,
}: {
  fileName: ReactNode;
  emptyText: string;
  buttonLabel: string;
  onPick: () => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  nameTestId?: string;
  testId?: string;
  /** The hidden `<input type="file">` the button clicks. */
  fileInput?: ReactNode;
  /**
   * A second button that opens a file on the machine megane runs on
   * (`useRemoteFilePick`), shown when the host registered a remote source.
   */
  remote?: { label: string; onPick: () => void; testId?: string } | null;
  /** Lines under the name: facts, errors, extra controls. */
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      onDrop={onDrop}
      onDragOver={onDragOver}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 10,
        border: "1px dashed var(--megane-border-strong)",
        borderRadius: 8,
        background: "var(--megane-surface-raised)",
      }}
    >
      <div data-testid={nameTestId} style={fileName ? nodeFileNameStyle : emptyFileStyle}>
        {fileName || emptyText}
      </div>
      {children}
      <button type="button" onClick={onPick} style={nodeButtonStyle}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {buttonLabel}
      </button>
      {remote && (
        <button
          type="button"
          onClick={remote.onPick}
          style={nodeButtonStyle}
          data-testid={remote.testId}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="20" height="7" rx="2" />
            <rect x="2" y="14" width="20" height="7" rx="2" />
            <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
            <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
          </svg>
          {remote.label}
        </button>
      )}
      {fileInput}
    </div>
  );
}
