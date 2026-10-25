/**
 * Bytes of geometry and texture data a scene holds, for the performance HUD.
 *
 * Counts every geometry attribute (vertex, index, instanced, interleaved),
 * each InstancedMesh's instance matrices and colours, and the pixels of every
 * texture a material references directly or through a shader uniform. three.js
 * keeps these arrays on the CPU after uploading them, so the total is both what
 * the renderer holds in JS and about what it occupies on the GPU. An array or
 * texture reached from several objects is counted once.
 */

import type * as THREE from "three";

type ArrayLike = { byteLength: number };

interface AttributeLike {
  array?: ArrayLike;
  data?: { array?: ArrayLike };
}

interface TextureLike {
  isTexture: true;
  image?: { data?: ArrayLike; width?: number; height?: number } | null;
}

function isTexture(value: unknown): value is TextureLike {
  return typeof value === "object" && value !== null && (value as TextureLike).isTexture === true;
}

function textureBytes(tex: TextureLike): number {
  const image = tex.image;
  if (!image) return 0;
  if (image.data) return image.data.byteLength;
  // Canvas / image sources upload as 8-bit RGBA.
  return (image.width ?? 0) * (image.height ?? 0) * 4;
}

export function sceneBufferBytes(root: THREE.Object3D): number {
  const seen = new Set<object>();
  let bytes = 0;

  const addArray = (array: ArrayLike | undefined): void => {
    if (!array || seen.has(array)) return;
    seen.add(array);
    bytes += array.byteLength;
  };
  const addAttribute = (attr: AttributeLike | null | undefined): void => {
    if (!attr) return;
    // An interleaved attribute is a view into its buffer's array.
    addArray(attr.array ?? attr.data?.array);
  };
  const addTexture = (value: unknown): void => {
    if (!isTexture(value) || seen.has(value)) return;
    seen.add(value);
    bytes += textureBytes(value);
  };

  root.traverse((obj) => {
    const mesh = obj as Partial<THREE.InstancedMesh>;
    const geometry = mesh.geometry;
    if (geometry && !seen.has(geometry)) {
      seen.add(geometry);
      for (const attr of Object.values(geometry.attributes)) addAttribute(attr);
      addAttribute(geometry.index);
    }
    addAttribute(mesh.instanceMatrix);
    addAttribute(mesh.instanceColor);

    const material = mesh.material;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const mat of materials) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      for (const value of Object.values(mat)) addTexture(value);
      const uniforms = (mat as Partial<THREE.ShaderMaterial>).uniforms;
      if (uniforms) for (const u of Object.values(uniforms)) addTexture(u?.value);
    }
  });
  return bytes;
}
