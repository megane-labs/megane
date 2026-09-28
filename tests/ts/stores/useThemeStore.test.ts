import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useThemeStore,
  resolveTheme,
  themeToHex,
  detectHostTheme,
  installThemeSync,
  type Theme,
} from "@/stores/useThemeStore";
import { THEME_STYLE_ID } from "@/styles/themeTokens";

const STORAGE_KEY = "megane-theme";

function resetStore(theme: Theme = "system") {
  useThemeStore.setState({
    theme,
    resolvedTheme: theme === "dark" ? "dark" : "light",
  });
}

describe("resolveTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 'light' for an explicit light theme", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("returns 'dark' for an explicit dark theme", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("returns 'dark' when system prefers dark", () => {
    vi.stubGlobal("window", {
      ...window,
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });
    expect(resolveTheme("system")).toBe("dark");
  });

  it("returns 'light' when system prefers light", () => {
    vi.stubGlobal("window", {
      ...window,
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });
    expect(resolveTheme("system")).toBe("light");
  });

  it("returns 'light' when matchMedia is unavailable", () => {
    vi.stubGlobal("window", { ...window, matchMedia: undefined });
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("themeToHex", () => {
  it("maps 'light' to white (0xffffff)", () => {
    expect(themeToHex("light")).toBe(0xffffff);
  });

  it("maps 'dark' to slate-900-ish (0x0f172a)", () => {
    expect(themeToHex("dark")).toBe(0x0f172a);
  });
});

describe("useThemeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("setTheme persists the chosen theme and updates resolvedTheme", () => {
    useThemeStore.getState().setTheme("dark");

    expect(useThemeStore.getState().theme).toBe("dark");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });

  it("setTheme('light') resolves to light regardless of system preference", () => {
    vi.stubGlobal("window", {
      ...window,
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    useThemeStore.getState().setTheme("light");

    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  it("setTheme('system') resolves via matchMedia", () => {
    vi.stubGlobal("window", {
      ...window,
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    useThemeStore.getState().setTheme("system");

    expect(useThemeStore.getState().theme).toBe("system");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });

  it("setTheme tolerates a localStorage that throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => useThemeStore.getState().setTheme("dark")).not.toThrow();
    expect(useThemeStore.getState().theme).toBe("dark");
    setItem.mockRestore();
  });

  it("_syncSystemTheme updates resolvedTheme only when theme is 'system'", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("window", { ...window, matchMedia });

    useThemeStore.setState({ theme: "system", resolvedTheme: "light" });
    useThemeStore.getState()._syncSystemTheme();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");

    useThemeStore.setState({ theme: "light", resolvedTheme: "light" });
    matchMedia.mockReturnValue({ matches: true });
    useThemeStore.getState()._syncSystemTheme();
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });
});

describe("useThemeStore initial load", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates theme from localStorage when a valid value is stored", async () => {
    localStorage.setItem(STORAGE_KEY, "dark");
    const mod = await import("@/stores/useThemeStore");
    expect(mod.useThemeStore.getState().theme).toBe("dark");
    expect(mod.useThemeStore.getState().resolvedTheme).toBe("dark");
  });

  it("falls back to 'system' when stored value is invalid", async () => {
    localStorage.setItem(STORAGE_KEY, "neon");
    const mod = await import("@/stores/useThemeStore");
    expect(mod.useThemeStore.getState().theme).toBe("system");
  });

  it("falls back to 'system' when localStorage.getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mod = await import("@/stores/useThemeStore");
    expect(mod.useThemeStore.getState().theme).toBe("system");
  });
});

describe("detectHostTheme", () => {
  afterEach(() => {
    document.body.className = "";
    document.body.removeAttribute("data-jp-theme-light");
    document.body.removeAttribute("data-vscode-theme-kind");
  });

  it("returns null when the host says nothing", () => {
    expect(detectHostTheme()).toBeNull();
  });

  it("returns null without a document body", () => {
    expect(detectHostTheme(undefined)).toBeNull();
    expect(detectHostTheme({ body: null } as unknown as Document)).toBeNull();
  });

  it("reads JupyterLab's data-jp-theme-light", () => {
    document.body.setAttribute("data-jp-theme-light", "false");
    expect(detectHostTheme()).toBe("dark");
    document.body.setAttribute("data-jp-theme-light", "true");
    expect(detectHostTheme()).toBe("light");
  });

  it.each([
    ["vscode-dark", "dark"],
    ["vscode-high-contrast", "dark"],
    ["vscode-light", "light"],
    ["vscode-high-contrast-light", "light"],
  ] as const)("reads VSCode body class %s", (cls, expected) => {
    document.body.classList.add(cls);
    expect(detectHostTheme()).toBe(expected);
  });

  it("treats high-contrast-light as light even alongside the hc class", () => {
    document.body.classList.add("vscode-high-contrast", "vscode-high-contrast-light");
    expect(detectHostTheme()).toBe("light");
  });

  it.each([
    ["vscode-dark", "dark"],
    ["vscode-high-contrast", "dark"],
    ["vscode-light", "light"],
    ["vscode-high-contrast-light", "light"],
  ] as const)("reads data-vscode-theme-kind=%s", (kind, expected) => {
    document.body.setAttribute("data-vscode-theme-kind", kind);
    expect(detectHostTheme()).toBe(expected);
  });

  it("makes 'system' follow the host over the OS preference", () => {
    vi.stubGlobal("window", {
      ...window,
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });
    document.body.classList.add("vscode-dark");
    expect(resolveTheme("system")).toBe("dark");
    vi.unstubAllGlobals();
  });
});

describe("installThemeSync", () => {
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetStore("system");
    document.getElementById(THEME_STYLE_ID)?.remove();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.removeAttribute("data-jp-theme-light");
    vi.unstubAllGlobals();
  });

  it("injects the tokens and writes data-theme", () => {
    uninstall = installThemeSync();
    expect(document.getElementById(THEME_STYLE_ID)).not.toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("follows setTheme until uninstalled", () => {
    uninstall = installThemeSync();
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    uninstall();
    uninstall = null;
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("re-resolves 'system' when the host theme attribute flips", async () => {
    uninstall = installThemeSync();
    document.body.setAttribute("data-jp-theme-light", "false");
    // MutationObserver callbacks run as microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("re-resolves 'system' when the OS preference changes", () => {
    let listener: (() => void) | undefined;
    const mq = {
      matches: false,
      addEventListener: vi.fn((_: string, cb: () => void) => (listener = cb)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("window", { ...window, matchMedia: vi.fn(() => mq) });
    uninstall = installThemeSync();
    mq.matches = true;
    listener?.();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    uninstall();
    uninstall = null;
    expect(mq.removeEventListener).toHaveBeenCalledWith("change", listener);
  });
});
