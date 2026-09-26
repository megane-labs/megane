/**
 * Google Analytics for the docs site, the Docusaurus counterpart of the
 * app's `src/analytics.ts`.
 *
 * Opt-in at build time: tracking is configured only when `GA_MEASUREMENT_ID`
 * is set (docs.yml passes the `GA_MEASUREMENT_ID` repository variable), so
 * local `docusaurus start` / `build` runs never contact Google. Like the app,
 * a tracked build still sends nothing when the browser sends Do Not Track or
 * Global Privacy Control.
 */
// Plain JS (typed via JSDoc) so the root vitest suite can import it without
// the docs' own node_modules, which `docs/tsconfig.json` extends.
// @ts-check

const MEASUREMENT_ID_RE = /^G-[A-Z0-9]+$/;

/**
 * The validated measurement ID, or `undefined` when tracking is off.
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
export function gaMeasurementId(raw) {
  const id = raw?.trim();
  return id && MEASUREMENT_ID_RE.test(id) ? id : undefined;
}

/**
 * `gtag` options for `@docusaurus/preset-classic`, or `undefined` when off.
 * @param {string | undefined} id
 * @returns {{ trackingID: string, anonymizeIP: boolean } | undefined}
 */
export function gtagPresetOptions(id) {
  return id ? { trackingID: id, anonymizeIP: true } : undefined;
}

/**
 * An inline `<head>` script that sets GA's documented `ga-disable-<ID>` opt-out
 * flag when the browser asks not to be tracked. It runs before the async
 * gtag.js loads, so no hit is ever sent.
 * @param {string | undefined} id
 * @returns {{ tagName: string, innerHTML: string }[]}
 */
export function gaOptOutHeadTags(id) {
  if (!id) return [];
  return [
    {
      tagName: "script",
      innerHTML:
        "(function(){var n=navigator;" +
        'if(n.globalPrivacyControl===true||n.doNotTrack==="1"||window.doNotTrack==="1")' +
        `{window[${JSON.stringify(`ga-disable-${id}`)}]=true;}})();`,
    },
  ];
}
