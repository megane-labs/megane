/**
 * Canvas 2D overlay for rendering per-atom text labels.
 * Overlays the WebGL canvas with a transparent canvas that uses
 * Canvas2D to draw text labels above atoms.
 */

import * as THREE from "three";
import { getColor } from "../constants";

const MAX_VISIBLE_LABELS = 500;
const FONT = "bold 11px sans-serif";
const LABEL_OFFSET_Y = -8; // pixels above atom center

export class LabelOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private labels: string[] | null = null;
  private elements: Uint8Array | null = null;
  private nAtoms = 0;
  private positions: Float32Array | null = null;
  private tmpVec = new THREE.Vector3();
  private lastWidth = 0;
  private lastHeight = 0;
  private lastPixelRatio = 1;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.pointerEvents = "none";
    this.ctx = this.canvas.getContext("2d")!;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  setLabels(labels: string[] | null): void {
    this.labels = labels;
  }

  /** The labels and the positions they are drawn at, for the headset (null: none). */
  getData(): { labels: string[]; positions: Float32Array; count: number } | null {
    if (!this.labels || !this.positions || this.nAtoms === 0) return null;
    return { labels: this.labels, positions: this.positions, count: this.nAtoms };
  }

  setAtomData(elements: Uint8Array, nAtoms: number): void {
    this.elements = elements;
    this.nAtoms = nAtoms;
  }

  setPositions(positions: Float32Array): void {
    this.positions = positions;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastPixelRatio = pixelRatio;
    this.canvas.width = Math.round(width * pixelRatio);
    this.canvas.height = Math.round(height * pixelRatio);
    // CSS size is set to 100% in constructor; only update physical canvas + transform
    this.ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  render(camera: THREE.Camera, width: number, height: number, pixelRatio: number = 1): void {
    // Auto-sync canvas size if dimensions or pixelRatio changed
    if (
      this.lastWidth !== width ||
      this.lastHeight !== height ||
      this.lastPixelRatio !== pixelRatio
    ) {
      this.resize(width, height, pixelRatio);
    }
    this.ctx.clearRect(0, 0, width, height);

    if (!this.labels || !this.positions || !this.elements || this.nAtoms === 0) {
      return;
    }

    const halfW = width / 2;
    const halfH = height / 2;

    // Project all atoms and collect visible ones
    type VisibleLabel = { sx: number; sy: number; z: number; idx: number };
    const visible: VisibleLabel[] = [];

    for (let i = 0; i < this.nAtoms; i++) {
      const label = this.labels[i];
      if (!label) continue;

      this.tmpVec.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      this.tmpVec.project(camera);

      // Frustum cull
      if (this.tmpVec.z < -1 || this.tmpVec.z > 1) continue;

      const sx = this.tmpVec.x * halfW + halfW;
      const sy = -(this.tmpVec.y * halfH) + halfH;

      if (sx < -50 || sx > width + 50 || sy < -20 || sy > height + 20) continue;

      visible.push({ sx, sy, z: this.tmpVec.z, idx: i });
    }

    // Sort by depth (front first) and cap
    visible.sort((a, b) => a.z - b.z);
    const count = Math.min(visible.length, MAX_VISIBLE_LABELS);

    this.ctx.font = FONT;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "bottom";

    for (let i = 0; i < count; i++) {
      const { sx, sy, idx } = visible[i];
      const label = this.labels[idx];
      const atomicNum = this.elements[idx];

      // Compute contrast color based on element color luminance
      const [r, g, b] = getColor(atomicNum);
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const textColor = luminance > 0.5 ? "#000000" : "#ffffff";
      const strokeColor = luminance > 0.5 ? "#ffffff" : "#000000";

      // Draw stroke for readability
      this.ctx.strokeStyle = strokeColor;
      this.ctx.lineWidth = 2.5;
      this.ctx.lineJoin = "round";
      this.ctx.strokeText(label, sx, sy + LABEL_OFFSET_Y);

      // Draw fill
      this.ctx.fillStyle = textColor;
      this.ctx.fillText(label, sx, sy + LABEL_OFFSET_Y);
    }
  }

  dispose(): void {
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
