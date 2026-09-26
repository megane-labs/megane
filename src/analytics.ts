/**
 * Google Analytics 4 for the hosted megane viewer and megane Builder.
 *
 * Opt-in at build time: nothing loads unless `VITE_GA_MEASUREMENT_ID` is set
 * when Vite builds the app. Only the public deploys (`deploy.yml`, `docs.yml`)
 * set it, so `megane serve`, the Python wheel, the npm library, the Jupyter
 * widget, the JupyterLab labextension and the VSCode extension never contact
 * Google.
 *
 * Even in a tracked build, nothing loads under E2E test mode or when the
 * browser sends Do Not Track / Global Privacy Control. Events carry no file
 * names or file contents: a file is reported by its extension only, and the
 * `#pipeline=` share-link hash is stripped from the reported page URL.
 */

import { isE2ETestMode } from "./testMode";

type Gtag = (...args: unknown[]) => void;

interface AnalyticsWindow {
  dataLayer?: unknown[];
  gtag?: Gtag;
}

/** Which app the page is, sent with every event as `megane_app`. */
export type AnalyticsApp = "viewer" | "builder";

const GA_SCRIPT_ORIGIN = "https://www.googletagmanager.com/gtag/js";
const MEASUREMENT_ID_RE = /^G-[A-Z0-9]+$/;

let active = false;

/** True when the browser asked not to be tracked (DNT or GPC). */
function trackingDeclined(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const win = window as Window & { doNotTrack?: string };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || win.doNotTrack === "1";
}

/** The page URL without its hash, which may hold a whole shared pipeline. */
function pageLocation(): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}`;
}

/**
 * Load gtag.js and send the initial page view. Returns whether analytics is
 * active. Safe to call more than once; only the first successful call loads.
 */
export function initAnalytics(
  app: AnalyticsApp,
  measurementId: string | undefined = import.meta.env.VITE_GA_MEASUREMENT_ID,
): boolean {
  if (active) return true;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const id = measurementId?.trim();
  if (!id || !MEASUREMENT_ID_RE.test(id)) return false;
  if (isE2ETestMode() || trackingDeclined()) return false;

  const w = window as unknown as AnalyticsWindow;
  w.dataLayer = w.dataLayer ?? [];
  // gtag.js reads the `arguments` object, not an array, off the dataLayer.
  w.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer!.push(arguments);
  };
  w.gtag("js", new Date());
  w.gtag("config", id, {
    page_location: pageLocation(),
    megane_app: app,
  });

  const script = document.createElement("script");
  script.async = true;
  script.src = `${GA_SCRIPT_ORIGIN}?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);

  active = true;
  return true;
}

/** Whether `initAnalytics` has loaded GA on this page. */
export function isAnalyticsActive(): boolean {
  return active;
}

/** Send a GA4 event. A no-op unless analytics is active. */
export function trackEvent(name: string, params: Record<string, string | number> = {}): void {
  if (!active) return;
  (window as unknown as AnalyticsWindow).gtag?.("event", name, params);
}

/**
 * Lower-cased extension of a file name, e.g. `"pdb"` or `"megane.json"`.
 * Only the extension is ever reported, never the name itself.
 */
export function fileFormat(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".megane.json")) return "megane.json";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "unknown";
  return lower.slice(dot + 1);
}

/** Report that the user opened a file of the given kind. */
export function trackFileOpen(kind: string, fileName: string): void {
  trackEvent("open_file", { file_kind: kind, file_format: fileFormat(fileName) });
}

/** Test hook: forget that analytics was initialized. */
export function resetAnalyticsForTests(): void {
  active = false;
}
