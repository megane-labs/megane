/**
 * The Light → Dark → Auto theme button of megane's panel toolbars. Each click
 * moves to the next theme; the icon and label show the current one. Shared by
 * the viewer's Pipeline panel and megane Builder's panel.
 */

import { useCallback } from "react";
import { useThemeStore, type Theme } from "../stores/useThemeStore";
import { tintedButtonStyle } from "./toolbarStyles";

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
  focusable: "false" as const,
  style: { flexShrink: 0, width: "1em", height: "1em" } as React.CSSProperties,
};

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ),
  dark: (
    <svg {...iconProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  system: (
    <svg {...iconProps}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
};

export const THEME_CYCLE: Theme[] = ["light", "dark", "system"];
export const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Auto" };

const themeBtnStyle = tintedButtonStyle("148, 163, 184", "var(--megane-text-secondary)", 0.3);

export interface ThemeCycleButtonProps {
  testId: string;
  /** The button's style (default: the grey toolbar pill). */
  style?: React.CSSProperties;
  /** Only the icon, at `iconSize` px (the label moves to the tooltip). */
  iconOnly?: boolean;
  /** Icon size in px (default 12, the toolbar pill's). */
  iconSize?: number;
}

export function ThemeCycleButton({
  testId,
  style = themeBtnStyle,
  iconOnly = false,
  iconSize = 12,
}: ThemeCycleButtonProps) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const handleCycle = useCallback(() => {
    setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]);
  }, [theme, setTheme]);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={handleCycle}
      style={style}
      title={`Theme: ${THEME_LABELS[theme]} (click to cycle)`}
      aria-label={`Switch theme, current: ${THEME_LABELS[theme]}`}
    >
      <span style={{ display: "inline-flex", fontSize: iconSize }}>{THEME_ICONS[theme]}</span>
      {!iconOnly && ` ${THEME_LABELS[theme]}`}
    </button>
  );
}
