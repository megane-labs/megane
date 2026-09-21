/**
 * Entry point of megane Builder (`builder.html`): the structure editor,
 * built as its own Vite entry beside the viewer.
 */

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BuilderApp } from "./BuilderApp";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useThemeStore } from "../stores/useThemeStore";
// Mantine's stylesheet backs every control of the Builder's chrome; megane.css
// keeps the shared `--megane-*` variables the renderer and the viewer use.
import "@mantine/core/styles.css";
import "../styles/megane.css";

/** Applies data-theme attribute to <html> and listens for OS preference changes. */
function ThemeSync() {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const syncSystem = useThemeStore((s) => s._syncSystemTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", syncSystem);
    return () => mq.removeEventListener("change", syncSystem);
  }, [syncSystem]);

  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="builder">
      <ThemeSync />
      <BuilderApp />
    </ErrorBoundary>
  </StrictMode>,
);
