import { describe, it, expect, vi, afterEach } from "vitest";
import { getXRSystem, MEGANE_XR_MODES, supportedXRModes } from "@/renderer/xr/xrSupport";

function fakeXR(isSessionSupported: (mode: XRSessionMode) => Promise<boolean>): XRSystem {
  return { isSessionSupported } as unknown as XRSystem;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getXRSystem", () => {
  it("returns navigator.xr when the browser has WebXR", () => {
    const xr = fakeXR(async () => true);
    vi.stubGlobal("navigator", { xr });
    expect(getXRSystem()).toBe(xr);
  });

  it("returns null without WebXR or without a navigator", () => {
    vi.stubGlobal("navigator", {});
    expect(getXRSystem()).toBeNull();
    vi.stubGlobal("navigator", undefined);
    expect(getXRSystem()).toBeNull();
  });
});

describe("supportedXRModes", () => {
  it("offers nothing without WebXR", async () => {
    expect(await supportedXRModes(null)).toEqual([]);
  });

  it("lists every supported mode in order", async () => {
    expect(await supportedXRModes(fakeXR(async () => true))).toEqual([...MEGANE_XR_MODES]);
  });

  it("leaves out unsupported modes and modes the page may not use", async () => {
    const xr = fakeXR(async (mode) => {
      if (mode === "immersive-ar") throw new DOMException("blocked", "SecurityError");
      return true;
    });
    expect(await supportedXRModes(xr)).toEqual(["immersive-vr"]);
    expect(await supportedXRModes(fakeXR(async (mode) => mode === "immersive-ar"))).toEqual([
      "immersive-ar",
    ]);
  });

  it("defaults to navigator.xr", async () => {
    vi.stubGlobal("navigator", { xr: fakeXR(async () => false) });
    expect(await supportedXRModes()).toEqual([]);
  });
});
