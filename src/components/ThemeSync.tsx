import { useEffect } from "react";
import { installThemeSync } from "../stores/useThemeStore";

/**
 * Applies the resolved theme to `<html data-theme>`, injects the colour
 * tokens, and follows OS / host (VSCode, JupyterLab) theme changes while the
 * "Auto" theme is selected. Mount once per page, next to the app root.
 */
export function ThemeSync(): null {
  useEffect(() => installThemeSync(), []);
  return null;
}
