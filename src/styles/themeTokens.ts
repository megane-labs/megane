/**
 * The light/dark colour tokens every megane UI component paints with.
 *
 * They live in TS rather than only in `megane.css` because not every host
 * loads that stylesheet: the anywidget bundle (`src/widget.ts`) and the npm
 * library (`src/lib.ts`) ship JS only. `ensureThemeTokens()` injects them once
 * per document, so a component's `var(--megane-text)` resolves on every host.
 *
 * Components use the tokens from inline styles
 * (`color: "var(--megane-text-secondary)"`); a hex literal in a component is a
 * colour that will not follow the theme. Accent fills behind white text
 * (primary buttons, badges) and translucent tints (`rgba(59,130,246,0.08)`)
 * read on both backgrounds and stay literal.
 *
 * The dark palette applies under `html[data-theme="dark"]`, which
 * `installThemeSync()` (src/stores/useThemeStore.ts) maintains.
 */

export const THEME_STYLE_ID = "megane-theme-tokens";

export const LIGHT_TOKENS: Record<string, string> = {
  bg: "#ffffff",
  // Floating panels (translucent, over the 3D canvas).
  surface: "rgba(255, 255, 255, 0.92)",
  // Opaque panel / card background.
  "surface-solid": "#f8f9fb",
  // Inputs, buttons, popovers, node cards: the "raised" white.
  "surface-raised": "#ffffff",
  // Subtle fills: hover rows, code blocks, disabled inputs.
  "surface-muted": "#f1f5f9",
  text: "#1e293b",
  "text-body": "#334155",
  "text-secondary": "#64748b",
  "text-muted": "#94a3b8",
  "text-faint": "#cbd5e1",
  border: "rgba(226, 232, 240, 0.6)",
  "border-solid": "#e2e8f0",
  "border-strong": "#cbd5e1",
  primary: "#3b82f6",
  // Blue used as text (links, active labels): darker than the fill.
  "primary-text": "#2563eb",
  danger: "#ef4444",
  "danger-text": "#b91c1c",
  "warning-text": "#b45309",
  "success-text": "#059669",
  shadow: "rgba(0, 0, 0, 0.06)",
  "shadow-strong": "rgba(0, 0, 0, 0.15)",
};

export const DARK_TOKENS: Record<string, string> = {
  bg: "#0f172a",
  surface: "rgba(15, 23, 42, 0.92)",
  "surface-solid": "#1e293b",
  "surface-raised": "#1e293b",
  "surface-muted": "#273549",
  text: "#e2e8f0",
  "text-body": "#cbd5e1",
  "text-secondary": "#94a3b8",
  "text-muted": "#64748b",
  "text-faint": "#475569",
  border: "rgba(51, 65, 85, 0.6)",
  "border-solid": "#334155",
  "border-strong": "#475569",
  primary: "#60a5fa",
  "primary-text": "#93c5fd",
  danger: "#f87171",
  "danger-text": "#fca5a5",
  "warning-text": "#fcd34d",
  "success-text": "#6ee7b7",
  shadow: "rgba(0, 0, 0, 0.3)",
  "shadow-strong": "rgba(0, 0, 0, 0.5)",
};

function block(selector: string, scheme: string, tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([k, v]) => `  --megane-${k}: ${v};`)
    .join("\n");
  return `${selector} {\n  color-scheme: ${scheme};\n${body}\n}`;
}

/** The stylesheet `ensureThemeTokens()` injects. */
export const THEME_TOKENS_CSS = [
  block(":root", "light", LIGHT_TOKENS),
  block('html[data-theme="dark"]', "dark", DARK_TOKENS),
].join("\n\n");

/**
 * Inject the token stylesheet into `doc` unless it is already there.
 * Idempotent and a no-op outside a DOM (SSR, workers).
 */
export function ensureThemeTokens(doc: Document | undefined = globalThis.document): void {
  if (!doc?.head || doc.getElementById(THEME_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = THEME_STYLE_ID;
  style.textContent = THEME_TOKENS_CSS;
  // First in <head> so a host stylesheet can still override a token.
  doc.head.insertBefore(style, doc.head.firstChild);
}
