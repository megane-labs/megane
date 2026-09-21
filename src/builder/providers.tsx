/**
 * The Builder's Mantine provider.
 *
 * Every Builder panel is built from Mantine components, so anything that
 * renders one — the app, and a section mounted on its own in a test — has to
 * sit under this. The colour scheme is not Mantine's own: megane already has
 * a theme store (`useThemeStore`, light / dark / system) that drives the
 * `data-theme` attribute and the `--megane-*` variables the renderer and the
 * viewer share, so the provider is forced to whatever that store resolved.
 */

import type { ReactNode } from "react";
import { MantineProvider, createTheme } from "@mantine/core";
import { useThemeStore } from "../stores/useThemeStore";

/**
 * A compact theme: the sidebar is 320 px wide, so the defaults are one size
 * down from Mantine's and the accent matches `--megane-primary`.
 */
export const builderTheme = createTheme({
  primaryColor: "blue",
  fontSizes: { xs: "11px", sm: "12px", md: "13px" },
  defaultRadius: "sm",
  components: {
    Button: { defaultProps: { size: "compact-sm" } },
    NumberInput: { defaultProps: { size: "xs" } },
    TextInput: { defaultProps: { size: "xs" } },
    NativeSelect: { defaultProps: { size: "xs" } },
    Checkbox: { defaultProps: { size: "xs" } },
    SegmentedControl: { defaultProps: { size: "xs" } },
    Text: { defaultProps: { size: "sm" } },
  },
});

export function BuilderProviders({ children }: { children: ReactNode }) {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  return (
    <MantineProvider theme={builderTheme} forceColorScheme={resolvedTheme}>
      {children}
    </MantineProvider>
  );
}
