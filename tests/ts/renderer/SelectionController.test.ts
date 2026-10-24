import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  SelectionController,
  MAX_SELECTED_ATOMS,
  HOVER_COLOR,
  type SelectionView,
} from "@/renderer/SelectionController";
import type { AtomLayerState } from "@/renderer/AtomLayerGroup";
import { BALL_STICK_ATOM_SCALE, getRadius } from "@/constants";
import type { Snapshot } from "@/types";

/**
 * Direct tests for SelectionController (picking + selection overlays split
 * out of MoleculeRenderer). The camera looks down -z at the origin with a
 * 10×10 world-unit orthographic frustum on a 100×100 px container, so one
 * world unit is 10 px and the origin is at pixel (50, 50).
 */

function mockContainer(width = 100, height = 100): HTMLElement {
  return {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => "",
    }),
  } as unknown as HTMLElement;
}

function ortho(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 4,
    nBonds: 0,
    positions: new Float32Array([0, 0, 0, 3, 0, 0, 3, 3, 0, 0, 3, 3]),
    elements: new Uint8Array([6, 7, 8, 1]),
    bonds: new Uint32Array(0),
    bondOrders: null,
  } as Snapshot;
}

function atomState(over: Partial<AtomLayerState> = {}): AtomLayerState {
  return {
    scale: 1,
    opacity: 1,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    radiusScale: BALL_STICK_ATOM_SCALE,
    uniformRadius: null,
    illustrative: false,
    visible: true,
    secondaryHiddenMask: null,
    ...over,
  };
}

interface ViewState {
  container: HTMLElement | null;
  snapshot: Snapshot | null;
  positions: Float32Array | null;
  atomState: AtomLayerState;
  radiusScale: number;
}

function setup(over: Partial<ViewState> = {}) {
  const state: ViewState = {
    container: mockContainer(),
    snapshot: makeSnapshot(),
    positions: null,
    atomState: atomState(),
    radiusScale: BALL_STICK_ATOM_SCALE,
    ...over,
  };
  const camera = ortho();
  const view: SelectionView = {
    getCamera: () => camera,
    getContainer: () => state.container,
    getSnapshot: () => state.snapshot,
    getCurrentPositions: () => state.positions ?? state.snapshot!.positions,
    getAtomState: () => state.atomState,
    getDrawingBoundary: () => null,
    getBondPeriodicImages: () => null,
    getAtomRadiusScale: () => state.radiusScale,
  };
  return { sel: new SelectionController(view), state, camera };
}

describe("SelectionController — measurement selection", () => {
  it("toggles atoms in and out and reports the selection", () => {
    const { sel } = setup();
    expect(sel.hasSelection).toBe(false);
    expect(sel.toggle(1)).toEqual({ atoms: [1] });
    expect(sel.toggle(2)).toEqual({ atoms: [1, 2] });
    expect(sel.selected).toEqual([1, 2]);
    expect(sel.hasSelection).toBe(true);
    expect(sel.toggle(1)).toEqual({ atoms: [2] });
  });

  it(`keeps at most ${MAX_SELECTED_ATOMS} atoms, dropping the oldest`, () => {
    const { sel } = setup();
    for (const i of [0, 1, 2, 3]) sel.toggle(i);
    expect(sel.toggle(1)).toEqual({ atoms: [0, 2, 3] });
    sel.toggle(1);
    expect(sel.toggle(4)).toEqual({ atoms: [2, 3, 1, 4] });
  });

  it("set() truncates and clear() empties", () => {
    const { sel } = setup();
    expect(sel.set([0, 1, 2, 3, 0])).toEqual({ atoms: [0, 1, 2, 3] });
    sel.clear();
    expect(sel.hasSelection).toBe(false);
    expect(sel.selectionGroup.children.length).toBe(0);
  });

  it("draws one sphere per atom plus a connecting line from two atoms on", () => {
    const { sel } = setup();
    sel.toggle(0);
    expect(sel.selectionGroup.children.length).toBe(1);
    sel.toggle(1);
    expect(sel.selectionGroup.children.length).toBe(3);
    const line = sel.selectionGroup.children.find((c) => c instanceof THREE.Line) as THREE.Line;
    expect(line.renderOrder).toBe(999);
  });

  it("sizes the highlight to the representation's radius scale", () => {
    const { sel, state } = setup({ radiusScale: 1 });
    sel.toggle(0);
    const sphere = sel.selectionGroup.children[0] as THREE.Mesh<THREE.SphereGeometry>;
    expect(sphere.geometry.parameters.radius).toBeCloseTo(getRadius(6) * 1.6, 6);
    state.radiusScale = 0.5;
    sel.refresh();
    const resized = sel.selectionGroup.children[0] as THREE.Mesh<THREE.SphereGeometry>;
    expect(resized.geometry.parameters.radius).toBeCloseTo(getRadius(6) * 0.5 * 1.6, 6);
  });

  it("refresh() follows the current (trajectory) positions", () => {
    const { sel, state } = setup();
    sel.toggle(1);
    state.positions = new Float32Array([0, 0, 0, 9, 9, 9, 0, 0, 0, 0, 0, 0]);
    sel.refresh();
    expect(sel.selectionGroup.children[0].position.toArray()).toEqual([9, 9, 9]);
  });

  it("draws nothing without a snapshot", () => {
    const { sel } = setup({ snapshot: null });
    sel.toggle(0);
    expect(sel.selectionGroup.children.length).toBe(0);
  });

  it("measures distance, angle and dihedral as atoms are added", () => {
    const { sel } = setup();
    sel.toggle(0);
    expect(sel.getMeasurement()).toBeNull();
    sel.toggle(1);
    expect(sel.getMeasurement()?.value).toBeCloseTo(3, 6);
    sel.toggle(2);
    expect(sel.getMeasurement()?.value).toBeCloseTo(90, 6);
    sel.toggle(3);
    expect(sel.getMeasurement()?.type).toBe("dihedral");
  });

  it("has no measurement without a snapshot", () => {
    const { sel, state } = setup();
    sel.set([0, 1]);
    state.snapshot = null;
    expect(sel.getMeasurement()).toBeNull();
  });
});

describe("SelectionController — preview highlight", () => {
  it("draws an uncapped preview independent of the measurement selection", () => {
    const { sel } = setup();
    sel.setPreview([0, 1, 2, 3]);
    expect(sel.previewSelectionGroup.children.length).toBe(4);
    expect(sel.selectionGroup.children.length).toBe(0);
    sel.setPreview(null);
    expect(sel.previewSelectionGroup.children.length).toBe(0);
  });

  it("refreshPreview() redraws the kept set at the current positions", () => {
    const { sel, state } = setup();
    sel.setPreview([1, 2]);
    state.positions = new Float32Array([0, 0, 0, 9, 9, 9, 1, 2, 3, 0, 0, 0]);
    sel.refreshPreview();
    const [a, b] = sel.previewSelectionGroup.children;
    expect(a.position.toArray()).toEqual([9, 9, 9]);
    expect(b.position.toArray()).toEqual([1, 2, 3]);
    sel.setPreview([]);
    sel.refreshPreview();
    expect(sel.previewSelectionGroup.children.length).toBe(0);
  });

  it("skips atoms the current structure no longer has", () => {
    const { sel, state } = setup();
    sel.setPreview([0, 3]);
    state.snapshot = { ...makeSnapshot(), nAtoms: 2, elements: new Uint8Array([6, 7]) };
    state.positions = new Float32Array([0, 0, 0, 3, 0, 0]);
    sel.refreshPreview();
    expect(sel.previewSelectionGroup.children.length).toBe(1);
  });

  it("draws nothing without a snapshot", () => {
    const { sel } = setup({ snapshot: null });
    sel.setPreview([0]);
    expect(sel.previewSelectionGroup.children.length).toBe(0);
  });
});

describe("SelectionController — Builder highlights", () => {
  it("draws the hover and warning layers in their own groups and follows the atoms", () => {
    const { sel, state } = setup();
    sel.setHover([1], 0xff0000);
    sel.setWarning([2, 3]);
    expect(sel.hoverGroup.children.length).toBe(1);
    expect(sel.warningGroup.children.length).toBe(2);
    const hover = sel.hoverGroup.children[0] as THREE.Mesh<
      THREE.SphereGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(hover.material.color.getHex()).toBe(0xff0000);
    state.positions = new Float32Array([0, 0, 0, 7, 7, 7, 0, 0, 0, 0, 0, 0]);
    sel.refreshHighlights();
    expect(sel.hoverGroup.children[0].position.toArray()).toEqual([7, 7, 7]);
    // Without a colour the hover is blue; null clears.
    sel.setHover([0]);
    const blue = sel.hoverGroup.children[0] as THREE.Mesh<
      THREE.SphereGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(blue.material.color.getHex()).toBe(HOVER_COLOR);
    sel.setHover(null);
    sel.setWarning(null);
    expect(sel.hoverGroup.children.length + sel.warningGroup.children.length).toBe(0);
  });
});

describe("SelectionController — drag gesture", () => {
  it("gives the camera axes, the pointer in viewport pixels and the pixel size", () => {
    const { sel } = setup();
    const g = sel.dragGesture(0, 50, 50, 70, 40)!;
    expect(g.from).toEqual([50, 50]);
    expect(g.to).toEqual([70, 40]);
    g.right.forEach((v, k) => expect(v).toBeCloseTo([1, 0, 0][k], 6));
    g.up.forEach((v, k) => expect(v).toBeCloseTo([0, 1, 0][k], 6));
    g.toCamera.forEach((v, k) => expect(v).toBeCloseTo([0, 0, 1][k], 6));
    // 10 world units over 100 px.
    expect(g.worldPerPixel).toBeCloseTo(0.1, 6);
    const [sx, sy] = g.project([3, 3, 0]);
    expect(sx).toBeCloseTo(80, 4);
    expect(sy).toBeCloseTo(20, 4);
  });

  it("is null without a view or for an atom that is not there", () => {
    expect(setup({ container: null }).sel.dragGesture(0, 0, 0, 1, 1)).toBeNull();
    expect(setup().sel.dragGesture(9, 0, 0, 1, 1)).toBeNull();
  });
});

describe("SelectionController — picking", () => {
  it("picks the atom a 3D ray points at, as drawn", () => {
    const { sel, state } = setup();
    const ray = new THREE.Ray(new THREE.Vector3(3, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(sel.pickOnRay(ray, 0)?.atomIndex).toBe(1);
    // Hidden by a per-atom opacity: not hit.
    state.atomState = atomState({ opacityOverrides: new Float32Array([1, 0, 1, 1]) });
    expect(sel.pickOnRay(ray, 0)).toBeNull();
    expect(setup({ snapshot: null }).sel.pickOnRay(ray, 0)).toBeNull();
  });

  it("picks the atom under the pixel", () => {
    const { sel } = setup();
    const hit = sel.pickAtPixel(80, 50);
    expect(hit?.kind).toBe("atom");
    expect(hit && hit.kind === "atom" ? hit.atomIndex : -1).toBe(1);
  });

  it("misses atoms the per-atom opacity hides", () => {
    const { sel } = setup({
      atomState: atomState({ opacityOverrides: new Float32Array([1, 0, 1, 1]) }),
    });
    expect(sel.pickAtPixel(80, 50)).toBeNull();
  });

  it("misses everything at zero global opacity", () => {
    const { sel } = setup({ atomState: atomState({ opacity: 0 }) });
    expect(sel.pickAtPixel(50, 50)).toBeNull();
  });

  it("returns null / [] without a container or snapshot", () => {
    expect(setup({ container: null }).sel.pickAtPixel(50, 50)).toBeNull();
    expect(setup({ snapshot: null }).sel.pickAtPixel(50, 50)).toBeNull();
    expect(setup({ container: null }).sel.atomsInRect({ x0: 0, y0: 0, x1: 99, y1: 99 })).toEqual(
      [],
    );
    expect(setup({ snapshot: null }).sel.projectAtoms()).toEqual([]);
  });

  it("box-selects the atoms whose centres fall in the rectangle", () => {
    const { sel } = setup();
    // Pixel x 40..90, y 40..60 covers atoms 0 (50,50) and 1 (80,50).
    expect(sel.atomsInRect({ x0: 90, y0: 60, x1: 40, y1: 40 }).sort()).toEqual([0, 1]);
  });

  it("projects every atom to viewer pixels", () => {
    const { sel } = setup();
    const projected = sel.projectAtoms();
    expect(projected).toHaveLength(4);
    expect(projected[1]).toMatchObject({ index: 1, element: 7 });
    expect(projected[1].sx).toBeCloseTo(80, 4);
    expect(projected[1].sy).toBeCloseTo(50, 4);
    expect(projected[1].depth).toBeCloseTo(10, 4);
  });

  it("converts a drag into a world delta in the atom's plane", () => {
    const { sel } = setup();
    const d = sel.dragDeltaForAtom(3, 10, 10, 40, 10)!;
    expect(d[0]).toBeCloseTo(3, 5);
    expect(d[1]).toBeCloseTo(0, 5);
    expect(d[2]).toBeCloseTo(0, 5);
  });

  it("rejects a drag on an out-of-range atom or without a view", () => {
    const { sel } = setup();
    expect(sel.dragDeltaForAtom(-1, 0, 0, 1, 1)).toBeNull();
    expect(sel.dragDeltaForAtom(4, 0, 0, 1, 1)).toBeNull();
    expect(setup({ container: null }).sel.dragDeltaForAtom(0, 0, 0, 1, 1)).toBeNull();
    expect(setup({ snapshot: null }).sel.dragDeltaForAtom(0, 0, 0, 1, 1)).toBeNull();
  });
});
