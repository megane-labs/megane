/**
 * Inline styles shared by the Builder's panels (sidebar, library, dialogs).
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

export function chipStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: disabled ? "default" : "pointer",
    border: active ? "1px solid #2563eb" : "1px solid var(--megane-border-solid, #cbd5e1)",
    background: active ? "#2563eb" : "var(--megane-surface-solid, #f1f5f9)",
    color: active ? "#fff" : disabled ? "#94a3b8" : "var(--megane-text, #334155)",
    userSelect: "none",
    opacity: disabled ? 0.6 : 1,
  };
}
