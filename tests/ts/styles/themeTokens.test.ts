import { describe, it, expect, beforeEach } from "vitest";
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  THEME_STYLE_ID,
  THEME_TOKENS_CSS,
  ensureThemeTokens,
} from "@/styles/themeTokens";

describe("theme tokens", () => {
  it("defines the same token names for light and dark", () => {
    expect(Object.keys(DARK_TOKENS).sort()).toEqual(Object.keys(LIGHT_TOKENS).sort());
  });

  it("emits a light :root block and a dark html[data-theme] block", () => {
    expect(THEME_TOKENS_CSS).toContain(":root {");
    expect(THEME_TOKENS_CSS).toContain('html[data-theme="dark"] {');
    expect(THEME_TOKENS_CSS).toContain("--megane-text: #1e293b;");
    expect(THEME_TOKENS_CSS).toContain("--megane-text: #e2e8f0;");
    expect(THEME_TOKENS_CSS).toContain("color-scheme: dark;");
  });

  it("every --megane-* token a component references is defined", async () => {
    // Guard against typos like var(--megane-text-seconday): scan the sources
    // that paint UI chrome and require each referenced token to exist.
    const files = import.meta.glob(
      [
        "../../../src/components/**/*.tsx",
        "../../../src/builder/**/*.tsx",
        "../../../src/tour/*.css",
      ],
      { query: "?raw", import: "default", eager: true },
    ) as Record<string, string>;
    const used = new Set<string>();
    for (const src of Object.values(files)) {
      for (const m of src.matchAll(/var\(--megane-([a-z-]+)/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((t) => !(t in LIGHT_TOKENS));
    expect(missing).toEqual([]);
  });
});

describe("ensureThemeTokens", () => {
  beforeEach(() => {
    document.getElementById(THEME_STYLE_ID)?.remove();
  });

  it("injects one <style> at the top of <head>, idempotently", () => {
    const other = document.createElement("style");
    document.head.appendChild(other);
    ensureThemeTokens();
    ensureThemeTokens();
    const styles = document.querySelectorAll(`#${THEME_STYLE_ID}`);
    expect(styles).toHaveLength(1);
    expect(document.head.firstChild).toBe(styles[0]);
    expect(styles[0].textContent).toBe(THEME_TOKENS_CSS);
    other.remove();
  });

  it("is a no-op without a document", () => {
    expect(() => ensureThemeTokens(undefined)).not.toThrow();
  });
});
