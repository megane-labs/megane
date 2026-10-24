/**
 * Text for the immersive view, drawn into canvas textures.
 *
 * The desktop draws labels and panels as HTML or on a 2D overlay canvas, none
 * of which reaches a headset. These helpers draw the same text into a 2D
 * canvas and hand it to three as a texture, for sprites (measurement and atom
 * labels) and the control panel. Where a canvas has no 2D context (jsdom), the
 * texture stays blank instead of failing.
 */

import * as THREE from "three";

/** Font stack for headset text: the platform UI font, bold enough to read. */
export const XR_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** A canvas of `width` × `height` pixels and its 2D context (null without one). */
export function createCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext("2d") };
}

/** Trace a rounded rectangle (not every 2D context has `roundRect`). */
export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export interface TextStyle {
  /** Font size (px) the text is drawn at; the texture's height follows it. */
  fontPx: number;
  fill: string;
  /** Outline for contrast over any background (none when omitted). */
  stroke?: string;
  /** Rounded plate behind the text (none when omitted). */
  background?: string;
}

/** A text texture and its width / height ratio, for sizing the sprite. */
export interface TextTexture {
  texture: THREE.CanvasTexture;
  aspect: number;
}

/** Draw `text` in `style` on a canvas just big enough for it. */
export function makeTextTexture(text: string, style: TextStyle): TextTexture {
  const font = `600 ${style.fontPx}px ${XR_FONT_FAMILY}`;
  const pad = Math.ceil(style.fontPx * (style.background ? 0.45 : 0.2));
  const height = Math.ceil(style.fontPx * 1.3) + pad * 2;
  const probe = createCanvas(1, 1).ctx;
  let textWidth = text.length * style.fontPx * 0.6;
  if (probe) {
    probe.font = font;
    textWidth = probe.measureText(text).width;
  }
  const width = Math.max(height, Math.ceil(textWidth) + pad * 2);
  const { canvas, ctx } = createCanvas(width, height);
  if (ctx) {
    if (style.background) {
      ctx.fillStyle = style.background;
      roundedRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();
    }
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (style.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = Math.max(2, style.fontPx / 8);
      ctx.lineJoin = "round";
      ctx.strokeText(text, width / 2, height / 2);
    }
    ctx.fillStyle = style.fill;
    ctx.fillText(text, width / 2, height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return { texture, aspect: width / height };
}

/**
 * An empty sprite for text, drawn on top of the scene: the headset's
 * equivalent of an HTML overlay. Give it text with {@link setSpriteText}.
 */
export function makeTextSprite(): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true }),
  );
  sprite.renderOrder = 1001;
  sprite.visible = false;
  return sprite;
}

/**
 * Show `text` on `sprite`, `height` tall (in the sprite's parent units).
 * `owned` hands the texture to the sprite, which disposes it when the text
 * next changes or the sprite is disposed; pass false for a cached texture
 * that other sprites share.
 */
export function setSpriteText(
  sprite: THREE.Sprite,
  text: TextTexture,
  height: number,
  owned: boolean,
): void {
  const material = sprite.material;
  if (material.map !== text.texture) {
    if (material.userData.ownsMap) material.map?.dispose();
    material.map = text.texture;
    material.userData.ownsMap = owned;
    material.needsUpdate = true;
  }
  sprite.scale.set(height * text.aspect, height, 1);
  sprite.visible = true;
}

/** Dispose a sprite made by {@link makeTextSprite}, and its texture if it owns it. */
export function disposeTextSprite(sprite: THREE.Sprite): void {
  if (sprite.material.userData.ownsMap) sprite.material.map?.dispose();
  sprite.material.dispose();
  sprite.removeFromParent();
}
