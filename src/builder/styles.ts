/**
 * Inline styles shared by the Builder's panels (sidebar, library, dialogs).
 *
 * Three kinds of control, each with its own look, so a glance tells what a
 * click does: a *segment* picks one of a set (tools, tabs), a *toggle* turns
 * a setting on or off, and a *button* runs an action (its `primary` variant
 * is the panel's commit, `danger` replaces or discards work).
 */

export const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid, #e2e8f0)",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--megane-surface-solid, #fff)",
};

export const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--megane-text-secondary, #64748b)",
};

export const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--megane-text-secondary, #64748b)",
};

export const inputStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--megane-text, #334155)",
  background: "var(--megane-surface-solid, #f1f5f9)",
  border: "1px solid var(--megane-border-solid, #cbd5e1)",
  borderRadius: 4,
  padding: "3px 6px",
};

export const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};

const ACCENT = "#2563eb";

/** A pill that is either the active choice or a plain action (legacy look). */
export function chipStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: disabled ? "default" : "pointer",
    border: active ? `1px solid ${ACCENT}` : "1px solid var(--megane-border-solid, #cbd5e1)",
    background: active ? ACCENT : "var(--megane-surface-solid, #f1f5f9)",
    color: active ? "#fff" : disabled ? "#94a3b8" : "var(--megane-text, #334155)",
    userSelect: "none",
    opacity: disabled ? 0.6 : 1,
  };
}

/** One choice of a segmented control: filled when it is the current one. */
export function segmentStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    border: "1px solid transparent",
    background: active ? ACCENT : "transparent",
    color: active ? "#fff" : disabled ? "#94a3b8" : "var(--megane-text, #334155)",
    fontWeight: active ? 600 : 400,
    userSelect: "none",
    opacity: disabled ? 0.6 : 1,
  };
}

/** The strip that holds a segmented control. */
export const segmentGroupStyle: React.CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: "var(--megane-border, rgba(226, 232, 240, 0.6))",
};

/** An on / off setting: outlined and tinted when on, never filled. */
export function toggleStyle(on: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    border: on ? `1px solid ${ACCENT}` : "1px solid var(--megane-border-solid, #cbd5e1)",
    background: on ? "rgba(37, 99, 235, 0.12)" : "transparent",
    color: on ? ACCENT : disabled ? "#94a3b8" : "var(--megane-text, #334155)",
    fontWeight: on ? 600 : 400,
    userSelect: "none",
    opacity: disabled ? 0.6 : 1,
  };
}

export type ButtonVariant = "default" | "primary" | "danger";

/** An action. `primary` is the one that commits a panel; `danger` replaces or discards. */
export function buttonStyle(
  variant: ButtonVariant = "default",
  disabled = false,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    userSelect: "none",
    opacity: disabled ? 0.5 : 1,
    fontFamily: "inherit",
    lineHeight: 1.3,
  };
  switch (variant) {
    case "primary":
      return {
        ...base,
        border: `1px solid ${ACCENT}`,
        background: ACCENT,
        color: "#fff",
        fontWeight: 600,
      };
    case "danger":
      return {
        ...base,
        border: "1px solid rgba(220, 38, 38, 0.5)",
        background: "transparent",
        color: "#b91c1c",
      };
    default:
      return {
        ...base,
        border: "1px solid var(--megane-border-solid, #cbd5e1)",
        background: "var(--megane-surface-solid, #f8f9fb)",
        color: disabled ? "#94a3b8" : "var(--megane-text, #1e293b)",
      };
  }
}
