/**
 * Render helper for the Builder's panels.
 *
 * Every Builder control is a Mantine component, so a panel mounted on its own
 * needs the same provider the app wraps itself in. `BuilderApp` brings its
 * own; these are for the sections rendered directly by their tests.
 */

import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { BuilderProviders } from "@/builder/providers";

export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, { wrapper: BuilderProviders, ...options });
}

export * from "@testing-library/react";
