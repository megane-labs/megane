import { describe, it, expect, vi, afterEach } from "vitest";
import * as THREE from "three";
import {
  createCanvas,
  disposeTextSprite,
  makeTextSprite,
  makeTextTexture,
  setSpriteText,
} from "@/renderer/xr/xrText";
import { stubCanvas2D } from "./fakeCanvas";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeTextTexture", () => {
  it("draws the text, outlined and on a plate, sized to fit", () => {
    const contexts = stubCanvas2D();
    const { texture, aspect } = makeTextTexture("2.410 Å", {
      fontPx: 40,
      fill: "#fff",
      stroke: "#000",
      background: "#2563eb",
    });
    const ctx = contexts[contexts.length - 1];
    expect(ctx.texts).toEqual(["2.410 Å"]);
    expect(ctx.strokeText).toHaveBeenCalledWith("2.410 Å", expect.any(Number), expect.any(Number));
    expect(ctx.fill).toHaveBeenCalled();
    const canvas = texture.image as HTMLCanvasElement;
    // 7 characters at 10 px each (the fake's measure) plus padding.
    expect(canvas.width).toBeGreaterThan(70);
    expect(aspect).toBeCloseTo(canvas.width / canvas.height, 9);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("draws plain text without a plate or outline", () => {
    const contexts = stubCanvas2D();
    makeTextTexture("CA", { fontPx: 20, fill: "#fff" });
    const ctx = contexts[contexts.length - 1];
    expect(ctx.strokeText).not.toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.texts).toEqual(["CA"]);
  });

  it("still returns a texture where the canvas has no 2D context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { texture, aspect } = makeTextTexture("O", { fontPx: 30, fill: "#fff" });
    expect(texture).toBeInstanceOf(THREE.CanvasTexture);
    // At least square, however short the text.
    expect(aspect).toBeGreaterThanOrEqual(1);
    expect(createCanvas(4, 2).canvas.width).toBe(4);
  });
});

describe("text sprites", () => {
  it("shows a texture at a height and swaps owned textures out", () => {
    stubCanvas2D();
    const sprite = makeTextSprite();
    expect(sprite.visible).toBe(false);
    expect(sprite.material.depthTest).toBe(false);
    const first = makeTextTexture("a", { fontPx: 20, fill: "#fff" });
    const dispose = vi.spyOn(first.texture, "dispose");
    setSpriteText(sprite, first, 2, true);
    expect(sprite.visible).toBe(true);
    expect(sprite.scale.y).toBe(2);
    expect(sprite.scale.x).toBeCloseTo(2 * first.aspect, 9);
    // Same texture: only the size changes.
    setSpriteText(sprite, first, 3, true);
    expect(dispose).not.toHaveBeenCalled();
    expect(sprite.scale.y).toBe(3);
    // A new texture replaces (and disposes) the owned one.
    const shared = makeTextTexture("b", { fontPx: 20, fill: "#fff" });
    setSpriteText(sprite, shared, 1, false);
    expect(dispose).toHaveBeenCalled();
    expect(sprite.material.map).toBe(shared.texture);
    // A shared texture is left alone on dispose.
    const sharedDispose = vi.spyOn(shared.texture, "dispose");
    const parent = new THREE.Group();
    parent.add(sprite);
    disposeTextSprite(sprite);
    expect(sharedDispose).not.toHaveBeenCalled();
    expect(sprite.parent).toBeNull();
  });

  it("disposes an owned texture with the sprite", () => {
    stubCanvas2D();
    const sprite = makeTextSprite();
    const owned = makeTextTexture("c", { fontPx: 20, fill: "#fff" });
    const dispose = vi.spyOn(owned.texture, "dispose");
    setSpriteText(sprite, owned, 1, true);
    disposeTextSprite(sprite);
    expect(dispose).toHaveBeenCalled();
  });
});
