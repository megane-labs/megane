/**
 * Shared styles for node forms shown in the pipeline editor's properties
 * pane, at 1:1 scale. (`ui.tsx`'s `smallBtnStyle` / `fileNameStyle` are sized
 * for the sidebar; these are their properties-pane counterparts.)
 */

export const nodeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 6,
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--megane-text-secondary)",
  transition: "all 0.15s",
};

export const nodeFileNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--megane-text)",
  wordBreak: "break-all",
};
