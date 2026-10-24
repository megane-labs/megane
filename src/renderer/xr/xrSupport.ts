/**
 * WebXR feature detection. Kept free of three.js so UI code can ask whether
 * an immersive session is possible without pulling in the renderer.
 */

/** The immersive session modes the viewer offers: VR, and passthrough AR. */
export type MeganeXRMode = "immersive-vr" | "immersive-ar";

export const MEGANE_XR_MODES: readonly MeganeXRMode[] = ["immersive-vr", "immersive-ar"];

/** `navigator.xr`, or null where the browser (or host webview) has no WebXR. */
export function getXRSystem(): XRSystem | null {
  if (typeof navigator === "undefined") return null;
  return navigator.xr ?? null;
}

/**
 * The modes this browser can start a session in right now. A headset has to
 * be attached (or be the device itself, as on Quest), the page has to be a
 * secure context, and an iframe host must grant `xr-spatial-tracking`; any
 * of those missing makes `isSessionSupported` resolve false or throw, and the
 * mode is left out.
 */
export async function supportedXRModes(
  xr: XRSystem | null = getXRSystem(),
): Promise<MeganeXRMode[]> {
  if (!xr) return [];
  const modes: MeganeXRMode[] = [];
  for (const mode of MEGANE_XR_MODES) {
    try {
      if (await xr.isSessionSupported(mode)) modes.push(mode);
    } catch {
      // SecurityError (permissions policy / insecure context): not offered.
    }
  }
  return modes;
}
