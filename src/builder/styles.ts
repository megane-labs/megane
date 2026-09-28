/**
 * Inline styles shared by the Builder's panels (sidebar, library, dialogs).
 *
 * Three kinds of control, each with its own look, so a glance tells what a
 * click does: a *segment* picks one of a set (tools, tabs), a *toggle* turns
 * a setting on or off, and a *button* runs an action (its `primary` variant
 * is the panel's commit, `danger` replaces or discards work).
 */

/** A card inside the floating panel, like a pipeline node card in the viewer. */
export const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid, #e2e8f0)",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--megane-surface-raised, #fff)",
};

/** The viewer's section label: small, uppercase, muted. */
export const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--megane-text-muted, #94a3b8)",
};

export const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--megane-text-secondary, #64748b)",
};

export const inputStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--megane-text-body, #334155)",
  background: "var(--megane-surface-raised, #fff)",
  border: "1px solid var(--megane-border-strong, #cbd5e1)",
  borderRadius: 4,
  padding: "3px 6px",
};

export const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};

/**
 * The viewer's blue (`--megane-primary` in the light theme). A fill behind
 * white text stays this literal so it reads on both themes; blue *text* uses
 * `ACCENT_TEXT`, which follows the theme.
 */
export const ACCENT = "#3b82f6";
export const ACCENT_TEXT = "var(--megane-primary-text, #2563eb)";
/** The translucent blue behind an active, unfilled choice (viewer tabs). */
export const ACCENT_TINT = "rgba(59, 130, 246, 0.1)";
const DISABLED_TEXT = "var(--megane-text-muted, #94a3b8)";

/** A pill that is either the active choice or a plain action (legacy look). */
export function chipStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: disabled ? "default" : "pointer",
    border: active ? `1px solid ${ACCENT}` : "1px solid var(--megane-border-strong, #cbd5e1)",
    background: active ? ACCENT : "var(--megane-surface-raised, #fff)",
    color: active ? "#fff" : disabled ? DISABLED_TEXT : "var(--megane-text-body, #334155)",
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
    color: active ? "#fff" : disabled ? DISABLED_TEXT : "var(--megane-text-body, #334155)",
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
    border: on ? `1px solid ${ACCENT}` : "1px solid var(--megane-border-strong, #cbd5e1)",
    background: on ? ACCENT_TINT : "transparent",
    color: on ? ACCENT_TEXT : disabled ? DISABLED_TEXT : "var(--megane-text-body, #334155)",
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
        border: "1px solid rgba(239, 68, 68, 0.5)",
        background: "transparent",
        color: "var(--megane-danger-text, #b91c1c)",
      };
    default:
      return {
        ...base,
        border: "1px solid var(--megane-border-strong, #cbd5e1)",
        background: "var(--megane-surface-raised, #fff)",
        color: disabled ? DISABLED_TEXT : "var(--megane-text, #1e293b)",
      };
  }
}
