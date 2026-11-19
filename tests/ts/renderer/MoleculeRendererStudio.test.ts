/**
 * MoleculeRenderer.renderStudio hands the scene to the studio renderer with
 * the selection overlay kept out of the lit set, hides the pivot marker for
 * the duration, then draws the cell-axes inset and labels over the result.
 * mount() needs WebGL, so the fields it touches are stubbed in.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

vi.mock("@/renderer/studio/StudioRenderer", () => ({ renderStudio: vi.fn(async () => {}) }));

import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { renderStudio } from "@/renderer/studio/StudioRenderer";

function stubbed() {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  const webgl = {
    getSize: (v: THREE.Vector2) => v.set(640, 480),
    getPixelRatio: () => 1,
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  internals.renderer = webgl;
  internals.scene = scene;
  internals.cameraController = { camera, controls: { update: vi.fn() } };
  internals.pivotMarker = { group: { visible: true } };
  internals.labelOverlay = { render: vi.fn() };
  internals.cellAxesRenderer = { render: vi.fn() };
  internals.polyhedronRenderer = { updateResolution: vi.fn() };
  return { r, internals, webgl, scene, camera };
}

describe("MoleculeRenderer.renderStudio", () => {
  beforeEach(() => vi.mocked(renderStudio).mockClear());

  it("renders through the studio with the selection as overlay, then insets and labels", async () => {
    const { r, internals, webgl, scene, camera } = stubbed();
    let pivotDuring: boolean | undefined;
    vi.mocked(renderStudio).mockImplementationOnce(async () => {
      pivotDuring = internals.pivotMarker.group.visible;
    });
    await r.renderStudio({ samples: 16, style: "soft" });

    expect(renderStudio).toHaveBeenCalledTimes(1);
    const [gl, s, cam, opts] = vi.mocked(renderStudio).mock.calls[0];
    expect(gl).toBe(webgl);
    expect(s).toBe(scene);
    expect(cam).toBe(camera);
    expect(opts.samples).toBe(16);
    expect(opts.style).toBe("soft");
    // No scene background: a transparent export.
    expect(opts.transparent).toBe(true);
    expect(opts.overlayRoots).toContain(internals.selection.selectionGroup);
    expect(opts.overlayRoots).toContain(internals.selection.hoverGroup);

    expect(pivotDuring).toBe(false);
    expect(internals.pivotMarker.group.visible).toBe(true);
    expect(internals.polyhedronRenderer.updateResolution).toHaveBeenCalledWith(640, 480);
    expect(internals.cellAxesRenderer.render).toHaveBeenCalledWith(webgl, camera, 640, 480);
    expect(internals.labelOverlay.render).toHaveBeenCalledWith(camera, 640, 480, 1);
  });

  it("keeps an opaque background opaque unless told otherwise", async () => {
    const { r, scene } = stubbed();
    scene.background = new THREE.Color(0xffffff);
    await r.renderStudio({ samples: 1, style: "studio" });
    expect(vi.mocked(renderStudio).mock.calls[0][3].transparent).toBe(false);
    await r.renderStudio({ samples: 1, style: "studio", transparent: true });
    expect(vi.mocked(renderStudio).mock.calls[1][3].transparent).toBe(true);
  });

  it("restores the pivot marker when the studio render fails, and survives a bad inset", async () => {
    const { r, internals } = stubbed();
    vi.mocked(renderStudio).mockRejectedValueOnce(new Error("context lost"));
    await expect(r.renderStudio({ samples: 1, style: "studio" })).rejects.toThrow("context lost");
    expect(internals.pivotMarker.group.visible).toBe(true);

    internals.cellAxesRenderer.render.mockImplementation(() => {
      throw new Error("inset");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(r.renderStudio({ samples: 1, style: "studio" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("works without a pivot marker, overlay, inset or polyhedra", async () => {
    const { r, internals } = stubbed();
    internals.pivotMarker = null;
    internals.labelOverlay = null;
    internals.cellAxesRenderer = null;
    internals.polyhedronRenderer = null;
    await expect(r.renderStudio({ samples: 1, style: "studio" })).resolves.toBeUndefined();
  });
});
