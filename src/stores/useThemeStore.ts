import { useEffect, type RefObject } from "react";
import { create } from "zustand";
import { DARK_TOKENS, LIGHT_TOKENS, ensureThemeTokens } from "../styles/themeTokens";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "megane-theme";

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // ignore storage errors (private browsing, cross-origin)
  }
  return "system";
}

function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}

/**
 * The theme the embedding host (not the OS) is showing, when it says so.
 *
 * - JupyterLab marks `<body data-jp-theme-light="true|false">`.
 * - VSCode webviews (custom editor and notebook outputs) put `vscode-light`,
 *   `vscode-dark`, `vscode-high-contrast` or `vscode-high-contrast-light` on
 *   `<body>` and mirror it in `data-vscode-theme-kind`.
 *
 * A VSCode or JupyterLab theme can disagree with the OS preference, so
 * "system" follows the host first and `prefers-color-scheme` only elsewhere.
 */
export function detectHostTheme(
  doc: Document | undefined = globalThis.document,
): ResolvedTheme | null {
  const body = doc?.body;
  if (!body) return null;
  const jp = body.getAttribute("data-jp-theme-light");
  if (jp === "true") return "light";
  if (jp === "false") return "dark";
  const kind = body.getAttribute("data-vscode-theme-kind");
  const cls = body.classList;
  // High-contrast-light carries both hc classes in some VSCode versions, so
  // the light checks run first.
  if (
    kind === "vscode-light" ||
    kind === "vscode-high-contrast-light" ||
    cls.contains("vscode-light") ||
    cls.contains("vscode-high-contrast-light")
  ) {
    return "light";
  }
  if (
    kind === "vscode-dark" ||
    kind === "vscode-high-contrast" ||
    cls.contains("vscode-dark") ||
    cls.contains("vscode-high-contrast")
  ) {
    return "dark";
  }
  return null;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    const host = detectHostTheme();
    if (host) return host;
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

/** The theme's page background (`--megane-bg`) as a hex number, for the renderer. */
export function themeToHex(resolvedTheme: ResolvedTheme): number {
  const bg = (resolvedTheme === "dark" ? DARK_TOKENS : LIGHT_TOKENS).bg;
  return parseInt(bg.slice(1), 16);
}

/** Anything with a three.js clear colour to follow the theme (MoleculeRenderer). */
interface ThemedRenderer {
  setBackgroundColor(hex: number): void;
}

/** Paint `renderer`'s background with the current theme's page colour. */
export function applyThemeBackground(renderer: ThemedRenderer): void {
  renderer.setBackgroundColor(themeToHex(useThemeStore.getState().resolvedTheme));
}

/**
 * Keep the renderer in `rendererRef` painted with the theme's page colour as
 * the theme changes. Call {@link applyThemeBackground} when it is created.
 */
export function useRendererThemeBackground(rendererRef: RefObject<ThemedRenderer | null>): void {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  useEffect(() => {
    rendererRef.current?.setBackgroundColor(themeToHex(resolvedTheme));
  }, [rendererRef, resolvedTheme]);
}

interface ThemeStore {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Re-resolve "system" after the OS preference or the host theme changed. */
  _syncSystemTheme: () => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const theme = loadTheme();
  return {
    theme,
    resolvedTheme: resolveTheme(theme),

    setTheme: (theme) => {
      saveTheme(theme);
      set({ theme, resolvedTheme: resolveTheme(theme) });
    },

    _syncSystemTheme: () => {
      if (get().theme === "system") {
        const resolvedTheme = resolveTheme("system");
        if (resolvedTheme !== get().resolvedTheme) set({ resolvedTheme });
      }
    },
  };
});

/** Body attributes whose change can flip the host theme (see detectHostTheme). */
const HOST_THEME_ATTRIBUTES = ["class", "data-jp-theme-light", "data-vscode-theme-kind"];

/**
 * Keep `<html data-theme>` in step with the theme store, and the store's
 * "system" resolution in step with the OS preference and the host theme.
 * Also injects the colour tokens. Every host entry point calls this once
 * (directly, or through `<ThemeSync />`); the returned function undoes it.
 */
export function installThemeSync(root: HTMLElement = document.documentElement): () => void {
  ensureThemeTokens(root.ownerDocument);
  const sync = () => useThemeStore.getState()._syncSystemTheme();
  sync();
  root.setAttribute("data-theme", useThemeStore.getState().resolvedTheme);
  const unsubscribe = useThemeStore.subscribe((s) =>
    root.setAttribute("data-theme", s.resolvedTheme),
  );

  const mq =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  mq?.addEventListener("change", sync);

  const body = root.ownerDocument.body;
  const observer =
    body && typeof MutationObserver !== "undefined" ? new MutationObserver(sync) : null;
  observer?.observe(body, { attributes: true, attributeFilter: HOST_THEME_ATTRIBUTES });

  return () => {
    unsubscribe();
    mq?.removeEventListener("change", sync);
    observer?.disconnect();
  };
}
