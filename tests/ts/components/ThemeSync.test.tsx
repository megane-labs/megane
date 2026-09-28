import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ThemeSync } from "@/components/ThemeSync";
import { useThemeStore } from "@/stores/useThemeStore";
import { THEME_STYLE_ID } from "@/styles/themeTokens";

describe("<ThemeSync />", () => {
  beforeEach(() => {
    document.getElementById(THEME_STYLE_ID)?.remove();
    document.documentElement.removeAttribute("data-theme");
    useThemeStore.setState({ theme: "dark", resolvedTheme: "dark" });
  });

  it("applies the theme while mounted and stops following it after unmount", () => {
    const { unmount } = render(<ThemeSync />);
    expect(document.getElementById(THEME_STYLE_ID)).not.toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    unmount();
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
