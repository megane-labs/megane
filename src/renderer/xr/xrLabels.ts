/**
 * Labels in the immersive view: atom labels and the measurement readout.
 *
 * On the desktop atom labels are painted on a 2D overlay canvas
 * (`LabelOverlay`) and the measurement shows in the Measurement panel; neither
 * reaches a headset. Here both become sprites in the scene (structure space,
 * Å), sized in metres so they read the same at any model scale, and drawn on
 * top like the desktop overlay.
 *
 * A headset cannot afford hundreds of label sprites, and from inside a model
 * only the labels around you are readable anyway, so the atom labels show the
 * {@link XR_MAX_LABELS} labelled atoms nearest the head, in front of it,
 * re-chosen a few times a second.
 */

import * as THREE from "three";
import {
  disposeTextSprite,
  makeTextSprite,
  makeTextTexture,
  setSpriteText,
  type TextTexture,
} from "./xrText";

/** How many atom labels a session shows at once. */
export const XR_MAX_LABELS = 64;
/** Atom label text height (m). */
export const XR_LABEL_HEIGHT = 0.014;
/** Measurement readout height (m). */
export const XR_MEASURE_LABEL_HEIGHT = 0.024;
/** Seconds between re-choosing which atoms to label. */
export const XR_LABEL_REFRESH = 0.25;
/** Distinct label strings kept as textures before the cache starts over. */
const TEXTURE_CACHE_LIMIT = 512;

/** The per-atom labels on screen: what `LabelOverlay` draws on the desktop. */
export interface XRLabelSource {
  /** Label per drawn atom ("" or missing: none). */
  labels: readonly string[];
  /** Current positions (Å) of the drawn atoms, xyz triples. */
  positions: ArrayLike<number>;
  /** How many drawn atoms there are. */
  count: number;
}

/**
 * Indices of the (at most) `limit` labelled atoms nearest `head`, in front
 * of it along `forward` (structure space), nearest first.
 */
export function nearestLabelled(
  source: XRLabelSource,
  head: THREE.Vector3,
  forward: THREE.Vector3,
  limit: number,
): number[] {
  const picked: number[] = [];
  const dists: number[] = [];
  const { labels, positions, count } = source;
  for (let i = 0; i < count; i++) {
    if (!labels[i]) continue;
    const dx = positions[i * 3] - head.x;
    const dy = positions[i * 3 + 1] - head.y;
    const dz = positions[i * 3 + 2] - head.z;
    if (dx * forward.x + dy * forward.y + dz * forward.z <= 0) continue;
    const d = dx * dx + dy * dy + dz * dz;
    if (picked.length === limit && d >= dists[limit - 1]) continue;
    // Insert into the sorted short list.
    let k = picked.length === limit ? limit - 1 : picked.length;
    while (k > 0 && dists[k - 1] > d) {
      dists[k] = dists[k - 1];
      picked[k] = picked[k - 1];
      k--;
    }
    dists[k] = d;
    picked[k] = i;
  }
  return picked;
}

/** Atom labels as sprites, kept on the atoms nearest the head. */
export class XRAtomLabels {
  /** Lives in the scene (structure space) for the session. */
  readonly group = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];
  private readonly textures = new Map<string, TextTexture>();
  private shown: number[] = [];
  private sinceRefresh = Infinity;
  private source: XRLabelSource | null = null;

  constructor() {
    this.group.name = "megane-xr-labels";
  }

  /**
   * Show `source`'s labels for a head at `head` looking along `forward`
   * (structure space) with the model at `scale` m/Å, `dt` s after the last
   * call. Null hides them.
   */
  update(
    source: XRLabelSource | null,
    head: THREE.Vector3,
    forward: THREE.Vector3,
    scale: number,
    dt: number,
  ): void {
    this.sinceRefresh += dt;
    // A new label set (not merely new positions) is re-chosen right away.
    if (source?.labels !== this.source?.labels || source?.count !== this.source?.count) {
      this.sinceRefresh = Infinity;
    }
    this.source = source;
    if (!source) {
      this.shown = [];
    } else if (this.sinceRefresh >= XR_LABEL_REFRESH) {
      this.sinceRefresh = 0;
      this.shown = nearestLabelled(source, head, forward, XR_MAX_LABELS);
      if (this.textures.size > TEXTURE_CACHE_LIMIT) this.clearTextures();
    }
    const height = XR_LABEL_HEIGHT / scale;
    this.shown.forEach((atom, slot) => {
      const sprite = this.sprite(slot);
      const p = source!.positions;
      sprite.position.set(p[atom * 3], p[atom * 3 + 1], p[atom * 3 + 2]);
      setSpriteText(sprite, this.texture(source!.labels[atom]), height, false);
    });
    for (let slot = this.shown.length; slot < this.sprites.length; slot++) {
      this.sprites[slot].visible = false;
    }
  }

  /** How many labels are on display (for the E2E probe). */
  get count(): number {
    return this.shown.length;
  }

  private sprite(slot: number): THREE.Sprite {
    let sprite = this.sprites[slot];
    if (!sprite) {
      sprite = makeTextSprite();
      // Sit just above the atom's centre, as on the desktop.
      sprite.center.set(0.5, -0.25);
      this.sprites[slot] = sprite;
      this.group.add(sprite);
    }
    return sprite;
  }

  private texture(text: string): TextTexture {
    let texture = this.textures.get(text);
    if (!texture) {
      texture = makeTextTexture(text, { fontPx: 48, fill: "#ffffff", stroke: "#0f172a" });
      this.textures.set(text, texture);
    }
    return texture;
  }

  private clearTextures(): void {
    for (const { texture } of this.textures.values()) texture.dispose();
    this.textures.clear();
  }

  dispose(): void {
    for (const sprite of this.sprites) disposeTextSprite(sprite);
    this.sprites.length = 0;
    this.clearTextures();
    this.shown = [];
    this.source = null;
    this.group.removeFromParent();
  }
}

/** The measurement readout, floating above the measured atoms. */
export class XRMeasureLabel {
  readonly sprite = makeTextSprite();
  private drawn: { text: string; texture: TextTexture } | null = null;

  constructor() {
    this.sprite.name = "megane-xr-measure-label";
    this.sprite.center.set(0.5, -0.6);
  }

  /**
   * Show `text` at `at` (structure space) with the model at `scale` m/Å;
   * null text or position hides it.
   */
  update(text: string | null, at: THREE.Vector3 | null, scale: number): void {
    if (text === null || at === null) {
      this.sprite.visible = false;
      return;
    }
    if (this.drawn?.text !== text) {
      this.drawn = {
        text,
        texture: makeTextTexture(text, { fontPx: 64, fill: "#ffffff", background: "#2563eb" }),
      };
    }
    // The sprite owns the texture: it disposes the old one when the text changes.
    setSpriteText(this.sprite, this.drawn.texture, XR_MEASURE_LABEL_HEIGHT / scale, true);
    this.sprite.position.copy(at);
  }

  dispose(): void {
    disposeTextSprite(this.sprite);
    this.drawn = null;
  }
}
