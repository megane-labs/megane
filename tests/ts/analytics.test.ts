import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fileFormat,
  initAnalytics,
  isAnalyticsActive,
  resetAnalyticsForTests,
  trackEvent,
  trackFileOpen,
} from "@/analytics";

type GaWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
  doNotTrack?: string;
};

const ID = "G-TEST123";

function gaScripts(): HTMLScriptElement[] {
  return Array.from(document.head.querySelectorAll<HTMLScriptElement>("script")).filter((s) =>
    s.src.startsWith("https://www.googletagmanager.com/gtag/js"),
  );
}

/** The dataLayer entries as plain arrays. */
function calls(): unknown[][] {
  return ((window as GaWindow).dataLayer ?? []).map((a) => Array.from(a));
}

afterEach(() => {
  resetAnalyticsForTests();
  gaScripts().forEach((s) => s.remove());
  const w = window as GaWindow;
  delete w.dataLayer;
  delete w.gtag;
  delete w.doNotTrack;
  delete (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("initAnalytics", () => {
  it("does nothing without a measurement ID", () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "");
    expect(initAnalytics("viewer")).toBe(false);
    expect(initAnalytics("viewer", undefined)).toBe(false);
    expect(isAnalyticsActive()).toBe(false);
    expect(gaScripts()).toHaveLength(0);
    expect((window as GaWindow).gtag).toBeUndefined();
  });

  it("reads the measurement ID from the build env by default", () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", ID);
    expect(initAnalytics("builder")).toBe(true);
    expect(gaScripts()[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
  });

  it("rejects a malformed measurement ID", () => {
    expect(initAnalytics("viewer", "UA-1234-5")).toBe(false);
    expect(initAnalytics("viewer", 'G-1"><script>')).toBe(false);
    expect(gaScripts()).toHaveLength(0);
  });

  it("loads gtag.js once and sends a config without the URL hash", () => {
    window.history.replaceState(null, "", "/builder.html?utm_source=x#pipeline=abc");
    expect(initAnalytics("builder", ` ${ID} `)).toBe(true);
    expect(initAnalytics("builder", ID)).toBe(true);
    expect(isAnalyticsActive()).toBe(true);

    const scripts = gaScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].async).toBe(true);

    const [js, config] = calls();
    expect(js[0]).toBe("js");
    expect(js[1]).toBeInstanceOf(Date);
    expect(config).toEqual([
      "config",
      ID,
      {
        page_location: `${window.location.origin}/builder.html?utm_source=x`,
        megane_app: "builder",
      },
    ]);
  });

  it("stays off under E2E test mode", () => {
    window.history.replaceState(null, "", "/?test=1");
    expect(initAnalytics("viewer", ID)).toBe(false);
    expect(gaScripts()).toHaveLength(0);
  });

  it("honors Global Privacy Control", () => {
    vi.stubGlobal("navigator", { ...navigator, globalPrivacyControl: true });
    expect(initAnalytics("viewer", ID)).toBe(false);
  });

  it("honors navigator.doNotTrack", () => {
    vi.stubGlobal("navigator", { ...navigator, doNotTrack: "1" });
    expect(initAnalytics("viewer", ID)).toBe(false);
  });

  it("honors window.doNotTrack", () => {
    (window as GaWindow).doNotTrack = "1";
    expect(initAnalytics("viewer", ID)).toBe(false);
  });
});

describe("trackEvent", () => {
  it("is a no-op before analytics is initialized", () => {
    const gtag = vi.fn();
    (window as GaWindow).gtag = gtag;
    trackEvent("apply_template", { template_id: "protein" });
    expect(gtag).not.toHaveBeenCalled();
  });

  it("sends events once analytics is active", () => {
    initAnalytics("viewer", ID);
    trackEvent("apply_template", { template_id: "protein" });
    trackEvent("ping");
    expect(calls().slice(2)).toEqual([
      ["event", "apply_template", { template_id: "protein" }],
      ["event", "ping", {}],
    ]);
  });

  it("reports opened files by extension only", () => {
    initAnalytics("viewer", ID);
    trackFileOpen("structure", "/secret/Project X.PDB");
    expect(calls().at(-1)).toEqual([
      "event",
      "open_file",
      { file_kind: "structure", file_format: "pdb" },
    ]);
  });
});

describe("fileFormat", () => {
  it.each([
    ["caffeine.pdb", "pdb"],
    ["TRAJ.XTC", "xtc"],
    ["scene.megane.json", "megane.json"],
    ["archive.tar.gz", "gz"],
    ["README", "unknown"],
    [".hidden", "unknown"],
    ["trailing.", "unknown"],
  ])("%s → %s", (name, format) => {
    expect(fileFormat(name)).toBe(format);
  });
});
