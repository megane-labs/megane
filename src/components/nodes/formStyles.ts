/**
 * The one look every node form shares in the pipeline editor's properties
 * pane, at 1:1 scale: a column of rows, each a muted label on the left and its
 * control on the right, with controls of one height, radius and border. The
 * components that lay rows out with these live in `form.tsx`. (`ui.tsx`'s
 * `smallBtnStyle` / `fileNameStyle` are sized for the sidebar; these are their
 * properties-pane counterparts.)
 */

/** Height every single-line control (input, select, button) shares. */
export const CONTROL_HEIGHT = 28;

/** The width of the label column of a {@link Field} row. */
export const LABEL_WIDTH = 92;

/** A node form: rows stacked with an even gap. */
export const formStackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

/** One row: the label column, then the control column. */
export const fieldStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)`,
  alignItems: "center",
  columnGap: 10,
  minHeight: CONTROL_HEIGHT,
};

export const fieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "var(--megane-text-secondary)",
  lineHeight: 1.3,
};

/** The control column: its controls in a row, filling the width. */
export const fieldControlStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

/** Text and number inputs. */
export const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: CONTROL_HEIGHT,
  boxSizing: "border-box",
  padding: "0 8px",
  fontSize: 12,
  fontFamily: "inherit",
  color: "var(--megane-text)",
  background: "var(--megane-surface-raised)",
  border: "1px solid var(--megane-border-strong)",
  borderRadius: 6,
  outline: "none",
};

/** A query or other code-like input. */
export const codeInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const inputErrorStyle: React.CSSProperties = {
  borderColor: "var(--megane-danger)",
  background: "rgba(239, 68, 68, 0.08)",
};

export const selectStyle: React.CSSProperties = {
  ...inputStyle,
  padding: "0 4px 0 6px",
  cursor: "pointer",
};

export const colorInputStyle: React.CSSProperties = {
  width: 44,
  height: CONTROL_HEIGHT,
  boxSizing: "border-box",
  padding: 2,
  border: "1px solid var(--megane-border-strong)",
  borderRadius: 6,
  background: "var(--megane-surface-raised)",
  cursor: "pointer",
  flexShrink: 0,
};

export const sliderStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  cursor: "pointer",
  accentColor: "var(--megane-primary)",
};

/** The figure beside a slider. */
export const sliderValueStyle: React.CSSProperties = {
  minWidth: 40,
  textAlign: "right",
  fontSize: 12,
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
  color: "var(--megane-text-body)",
};

export const checkboxStyle: React.CSSProperties = {
  width: 15,
  height: 15,
  margin: 0,
  cursor: "pointer",
  accentColor: "var(--megane-primary)",
};

/** A small uppercase heading over a group of rows. */
export const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--megane-text-muted)",
};

/** A line of help under a control. */
export const hintStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: "var(--megane-text-muted)",
};

export const errorTextStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: "var(--megane-danger)",
};

/** A full-width action in a form (Load structure…). */
export const nodeButtonStyle: React.CSSProperties = {
  width: "100%",
  height: CONTROL_HEIGHT,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  background: "var(--megane-surface-raised)",
  border: "1px solid var(--megane-border-strong)",
  borderRadius: 6,
  padding: "0 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "inherit",
  color: "var(--megane-text-body)",
  transition: "background 0.15s",
};

export const nodeFileNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--megane-text)",
  wordBreak: "break-all",
};

/** What a loader shows before a file is opened. */
export const emptyFileStyle: React.CSSProperties = {
  fontSize: 12,
  fontStyle: "italic",
  color: "var(--megane-text-muted)",
};

/** A muted fact under a file name (voxel count, points). */
export const fileMetaStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--megane-text-secondary)",
};
