/**
 * "VR" / "AR" buttons that move the 3D view into a headset (WebXR).
 *
 * Rendered only where the browser can actually start an immersive session —
 * Quest Browser, visionOS Safari, desktop Chrome with an OpenXR runtime — so
 * every other host (including the VSCode webview, which has no WebXR) shows
 * nothing. "AR" is passthrough mixed reality: the structure floats in the room
 * the headset cameras see. The session itself lives in the renderer
 * (`MoleculeRenderer.enterXR`); on a headset the page is hidden while it runs,
 * and on a tethered PC headset the button turns into "Exit".
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { MeganeXRMode, MeganeXRState } from "../renderer/MoleculeRenderer";
import { getXRSystem, supportedXRModes } from "../renderer/xr/xrSupport";
import { overlayButtonStyle } from "./toolbarStyles";

/** The renderer surface the buttons drive (`MoleculeRenderer` implements it). */
export interface XRControlsTarget {
  enterXR(mode: MeganeXRMode): Promise<void>;
  exitXR(): Promise<void>;
  onXRStateChange(listener: (state: MeganeXRState) => void): () => void;
}

export interface XRControlsProps {
  /** The mounted renderer, read at click time (null before mount). */
  getTarget: () => XRControlsTarget | null;
  /** Extra style for the root (only rendered when a mode is supported). */
  style?: CSSProperties;
}

const MODE_LABEL: Record<MeganeXRMode, string> = {
  "immersive-vr": "VR",
  "immersive-ar": "AR",
};

const MODE_TITLE: Record<MeganeXRMode, string> = {
  "immersive-vr": "View in a VR headset (grab to move, both hands to scale)",
  "immersive-ar": "View in passthrough AR: the structure floats in your room",
};

const ROW_STYLE: CSSProperties = { display: "flex", gap: 4 };

const ERROR_STYLE: CSSProperties = {
  maxWidth: 220,
  fontSize: 11,
  color: "var(--megane-danger-text)",
};

export function XRControls({ getTarget, style }: XRControlsProps) {
  const [modes, setModes] = useState<MeganeXRMode[]>([]);
  const [active, setActive] = useState<MeganeXRMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      void supportedXRModes().then((supported) => {
        if (!cancelled) setModes(supported);
      });
    };
    check();
    // A tethered headset can be plugged in after the page loads.
    const xr = getXRSystem();
    xr?.addEventListener("devicechange", check);
    return () => {
      cancelled = true;
      xr?.removeEventListener("devicechange", check);
      unsubscribeRef.current?.();
    };
  }, []);

  if (modes.length === 0) return null;

  const enter = (mode: MeganeXRMode) => {
    const target = getTarget();
    if (!target) return;
    setError(null);
    if (!unsubscribeRef.current) {
      unsubscribeRef.current = target.onXRStateChange((state) => setActive(state.mode));
    }
    // No await before enterXR: the session request needs this click's
    // user activation.
    target.enterXR(mode).catch((err: unknown) => {
      setError(
        `${MODE_LABEL[mode]} could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  return (
    <div
      data-testid="xr-controls"
      style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}
    >
      <div role="group" aria-label="Immersive view" style={ROW_STYLE}>
        {active ? (
          <button
            type="button"
            data-testid="xr-exit"
            title="Leave the immersive view"
            onClick={() => void getTarget()?.exitXR()}
            style={overlayButtonStyle}
          >
            Exit {MODE_LABEL[active]}
          </button>
        ) : (
          modes.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`xr-enter-${MODE_LABEL[mode].toLowerCase()}`}
              title={MODE_TITLE[mode]}
              onClick={() => enter(mode)}
              style={overlayButtonStyle}
            >
              {MODE_LABEL[mode]}
            </button>
          ))
        )}
      </div>
      {error && (
        <div data-testid="xr-error" role="alert" style={ERROR_STYLE}>
          {error}
        </div>
      )}
    </div>
  );
}
