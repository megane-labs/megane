/**
 * Lighting presets for the publication (studio) renderer.
 *
 * All directions are in view space (x right, y up, z toward the viewer) and
 * point toward the light, so a preset lights the picture the same way however
 * the structure is turned — the way a photographer sets up a studio around
 * the camera. Colors are linear RGB radiance; the final pass tone-maps them.
 */

import { normalize, type Vec3 } from "./sampling";

export type StudioStyle = "studio" | "soft" | "dramatic" | "illustrative";

export const STUDIO_STYLES: readonly StudioStyle[] = ["studio", "soft", "dramatic", "illustrative"];

export const STUDIO_STYLE_LABELS: Record<StudioStyle, string> = {
  studio: "Studio",
  soft: "Soft clay",
  dramatic: "Dramatic",
  illustrative: "Illustrative",
};

export interface StudioSky {
  /** Radiance straight up, at the horizon and straight down (view space). */
  top: Vec3;
  horizon: Vec3;
  bottom: Vec3;
  intensity: number;
}

export interface StudioDirectionalLight {
  /** Toward the light, view space. */
  direction: Vec3;
  color: Vec3;
  intensity: number;
  /** Angular radius of the light in degrees: 0 is a hard point light. */
  softness: number;
}

export interface StudioOutline {
  /** Line width in output pixels. */
  width: number;
  /** Linear RGB. */
  color: Vec3;
  /**
   * Depth step (Å, in view space) above which a line is drawn. Touching atoms
   * at a similar depth get no seam, so silhouettes read stronger than the
   * internal edges.
   */
  threshold: number;
}

export interface StudioFloor {
  /**
   * How far the ground tilts toward the viewer, in degrees: 0 is a ground
   * seen edge-on (camera at floor level), 90 a backdrop facing the camera.
   */
  tilt: number;
  /** Darkness of a fully shadowed ground, 0..1. */
  strength: number;
}

export interface StudioLighting {
  sky: StudioSky;
  key: StudioDirectionalLight;
  /** Back light that catches the silhouettes; casts no shadow. */
  rim: StudioDirectionalLight | null;
  /** Strength of the key light's highlight, and its sharpness (Blinn-Phong exponent). */
  specular: number;
  shininess: number;
  /** Multiplier applied before tone mapping. */
  exposure: number;
  outline: StudioOutline | null;
  /** Invisible ground that catches the structure's shadow; null for none. */
  floor: StudioFloor | null;
}

const WHITE: Vec3 = [1, 1, 1];

export const STUDIO_PRESETS: Record<StudioStyle, StudioLighting> = {
  // A soft box up and to the left and a bright, slightly cool sky: the look of
  // a product shot. Strong contact shadows, gentle highlights.
  studio: {
    sky: {
      top: [1.0, 1.0, 1.02],
      horizon: [0.82, 0.84, 0.88],
      bottom: [0.42, 0.4, 0.38],
      intensity: 0.62,
    },
    key: {
      direction: normalize([-0.55, 0.7, 0.5]),
      color: [1.0, 0.97, 0.92],
      intensity: 1.0,
      softness: 10,
    },
    rim: null,
    specular: 0.22,
    shininess: 40,
    exposure: 1.0,
    outline: null,
    floor: { tilt: 40, strength: 0.6 },
  },
  // Almost all light from an even sky: every crevice darkens with how buried it
  // is (ambient occlusion), like a clay model under an overcast sky.
  soft: {
    sky: { top: WHITE, horizon: [0.95, 0.95, 0.95], bottom: [0.7, 0.7, 0.7], intensity: 1.02 },
    key: { direction: normalize([-0.4, 0.8, 0.45]), color: WHITE, intensity: 0.28, softness: 25 },
    rim: null,
    specular: 0.06,
    shininess: 16,
    exposure: 1.0,
    outline: null,
    floor: { tilt: 40, strength: 0.45 },
  },
  // One hard light from the side and a back light on the silhouettes; made for
  // a dark background.
  dramatic: {
    sky: {
      top: [0.7, 0.76, 0.9],
      horizon: [0.4, 0.42, 0.5],
      bottom: [0.1, 0.1, 0.12],
      intensity: 0.22,
    },
    key: {
      direction: normalize([-0.85, 0.45, 0.35]),
      color: [1.0, 0.95, 0.86],
      intensity: 1.75,
      softness: 4,
    },
    rim: {
      direction: normalize([0.6, 0.35, -0.75]),
      color: [0.75, 0.85, 1.0],
      intensity: 0.9,
      softness: 0,
    },
    specular: 0.45,
    shininess: 72,
    exposure: 1.0,
    outline: null,
    floor: { tilt: 35, strength: 0.8 },
  },
  // Flat colour shaped only by ambient occlusion, with ink outlines that hug
  // the silhouettes: the Goodsell-style figure.
  illustrative: {
    sky: { top: WHITE, horizon: WHITE, bottom: [0.85, 0.85, 0.85], intensity: 1.1 },
    key: { direction: normalize([-0.3, 0.6, 0.75]), color: WHITE, intensity: 0, softness: 0 },
    rim: null,
    specular: 0,
    shininess: 1,
    exposure: 1.0,
    outline: { width: 2.0, color: [0, 0, 0], threshold: 1.2 },
    floor: null,
  },
};

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Sky radiance arriving from view-space direction `dir`, intensity applied. */
export function skyRadiance(sky: StudioSky, dir: Vec3): Vec3 {
  const y = Math.max(-1, Math.min(1, dir[1]));
  const c = y >= 0 ? lerp3(sky.horizon, sky.top, y) : lerp3(sky.horizon, sky.bottom, -y);
  return [c[0] * sky.intensity, c[1] * sky.intensity, c[2] * sky.intensity];
}

/** View-space normal of a ground tilted `tiltDeg` toward the viewer. */
export function floorNormal(tiltDeg: number): Vec3 {
  const a = (tiltDeg * Math.PI) / 180;
  return normalize([0, Math.cos(a), Math.sin(a)]);
}
