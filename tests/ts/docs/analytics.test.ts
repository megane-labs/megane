import { afterEach, describe, expect, it, vi } from "vitest";
import { gaMeasurementId, gaOptOutHeadTags, gtagPresetOptions } from "../../../docs/analytics.mjs";

type OptOutWindow = Window & { doNotTrack?: string } & Record<string, unknown>;

const ID = "G-DOCS42";
const FLAG = `ga-disable-${ID}`;

/** Run the inline opt-out script the docs put in <head>. */
function runOptOut(): void {
  const [tag] = gaOptOutHeadTags(ID);
  new Function(tag.innerHTML as string)();
}

afterEach(() => {
  const w = window as OptOutWindow;
  delete w[FLAG];
  delete w.doNotTrack;
  vi.unstubAllGlobals();
});

describe("docs analytics config", () => {
  it("is off without a valid measurement ID", () => {
    for (const raw of [undefined, "", "  ", "UA-1-1", 'G-1"</script>']) {
      const id = gaMeasurementId(raw);
      expect(id).toBeUndefined();
      expect(gtagPresetOptions(id)).toBeUndefined();
      expect(gaOptOutHeadTags(id)).toEqual([]);
    }
  });

  it("configures the preset gtag plugin for a valid ID", () => {
    const id = gaMeasurementId(` ${ID} `);
    expect(id).toBe(ID);
    expect(gtagPresetOptions(id)).toEqual({ trackingID: ID, anonymizeIP: true });
    expect(gaOptOutHeadTags(id)).toHaveLength(1);
  });

  it("leaves tracking on for a browser that did not opt out", () => {
    runOptOut();
    expect((window as OptOutWindow)[FLAG]).toBeUndefined();
  });

  it("sets GA's opt-out flag under Global Privacy Control", () => {
    vi.stubGlobal("navigator", { ...navigator, globalPrivacyControl: true });
    runOptOut();
    expect((window as OptOutWindow)[FLAG]).toBe(true);
  });

  it("sets GA's opt-out flag under Do Not Track", () => {
    vi.stubGlobal("navigator", { ...navigator, doNotTrack: "1" });
    runOptOut();
    expect((window as OptOutWindow)[FLAG]).toBe(true);
  });

  it("sets GA's opt-out flag under window.doNotTrack", () => {
    (window as OptOutWindow).doNotTrack = "1";
    runOptOut();
    expect((window as OptOutWindow)[FLAG]).toBe(true);
  });
});
