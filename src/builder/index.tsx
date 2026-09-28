/**
 * Entry point of megane Builder (`builder.html`): the structure editor,
 * built as its own Vite entry beside the viewer.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BuilderApp } from "./BuilderApp";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThemeSync } from "../components/ThemeSync";
import { initAnalytics } from "../analytics";
import "../styles/megane.css";

initAnalytics("builder");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="builder">
      <ThemeSync />
      <BuilderApp />
    </ErrorBoundary>
  </StrictMode>,
);
