import React, { useEffect, useRef, useState } from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./HeroViewer.module.css";
import { startAutoRotate } from "../../../src/renderer/cameraAutoRotate";

/**
 * HeroViewer — the landing hero's live, auto-rotating structure.
 *
 * It mounts the real `MoleculeRenderer` (the same viewer the docs and Gallery
 * use) as a non-interactive dark backdrop: the WebGL context is created lazily
 * once the hero scrolls into view AND the browser is idle, so it never blocks
 * first paint / LCP. The renderer is mounted ONCE; changing `mode` only swaps
 * the loaded structure (no context teardown), so the landing can cycle between
 * structures over time without GPU churn.
 *
 * Colors are literal (not --ifm-* tokens): the hero is always dark regardless
 * of the docs color mode.
 */
export type HeroMode = "molecular" | "protein" | "perovskite" | "quartz";

/** How each mode is rendered:
 *  - "molecular": ball-and-stick atoms
 *  - "polyhedra": atoms + coordination polyhedra overlay (crystals)
 *  - "cartoon":   protein ribbon + translucent molecular-surface mesh overlay */
type ModeKind = "molecular" | "polyhedra" | "cartoon";

const MODE_DATA: Record<HeroMode, { data: string; kind: ModeKind }> = {
  molecular: { data: "caffeine_water", kind: "molecular" },
  protein: { data: "ubiquitin", kind: "cartoon" },
  perovskite: { data: "perovskite_srtio3", kind: "polyhedra" },
  quartz: { data: "quartz_sio2", kind: "polyhedra" },
};

const HERO_BG = 0x0a0c10;

async function fetchSnapshot(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const snap = await res.json();
  const out: any = {
    nAtoms: snap.nAtoms,
    nBonds: snap.nBonds,
    nFileBonds: snap.nFileBonds,
    positions: new Float32Array(snap.positions),
    elements: new Uint8Array(snap.elements),
    bonds: new Uint32Array(snap.bonds),
    bondOrders: snap.bondOrders ? new Uint8Array(snap.bondOrders) : null,
    box: snap.box ? new Float32Array(snap.box) : null,
  };
  // Cα backbone + secondary structure for cartoon-ribbon rendering.
  if (snap.caIndices) {
    out.caIndices = new Uint32Array(snap.caIndices);
    out.caChainIds = new Uint8Array(snap.caChainIds);
    out.caResNums = new Uint32Array(snap.caResNums);
    out.caSsType = new Uint8Array(snap.caSsType);
  }
  return out;
}

export default function HeroViewer({ mode }: { mode: HeroMode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<any>(null);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);

  const modeInfo = MODE_DATA[mode] ?? MODE_DATA.molecular;
  const resolvedSrc = useBaseUrl(`/data/${modeInfo.data}.json`);
  const kind = modeInfo.kind;

  // Mount the renderer once (lazy: on intersection + idle).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    if (!container) return;

    let renderer: any = null;
    let stopAutoRotate: (() => void) | null = null;
    let observer: IntersectionObserver | null = null;
    let idleHandle: number | null = null;
    let unmounted = false;

    const prefersReducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    async function init() {
      if (unmounted || !container) return;
      const { MoleculeRenderer } = await import("../../../src/renderer/MoleculeRenderer");
      if (unmounted || !container) return;

      renderer = new MoleculeRenderer();
      renderer.mount(container);
      renderer.setBackgroundColor(HERO_BG);

      // Backdrop, not a control surface: no pointer interaction, and a slow
      // orbit (one turn every ~43 s, the old OrbitControls autoRotateSpeed
      // 1.4) unless the visitor prefers reduced motion.
      renderer.setControlsEnabled(false);
      // The rotation-centre cross is a control affordance, not part of the
      // structure; a backdrop you cannot rotate has no use for it.
      renderer.setPivotMarkerVisible(false);
      if (!prefersReducedMotion) {
        stopAutoRotate = startAutoRotate(renderer, 8.4);
      }
      rendererRef.current = renderer;
      setMounted(true);
    }

    function schedule() {
      const ric: typeof window.requestIdleCallback | undefined = (window as any)
        .requestIdleCallback;
      if (ric) idleHandle = ric(() => init(), { timeout: 1200 });
      else idleHandle = window.setTimeout(() => init(), 300) as any;
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          observer?.disconnect();
          observer = null;
          schedule();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(container);

    return () => {
      unmounted = true;
      observer?.disconnect();
      if (idleHandle != null) {
        const cic: typeof window.cancelIdleCallback | undefined = (window as any)
          .cancelIdleCallback;
        if (cic) cic(idleHandle);
        else clearTimeout(idleHandle);
      }
      stopAutoRotate?.();
      if (renderer) renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Load / swap the structure whenever the mode changes (once mounted). The
  // crystal additionally renders coordination polyhedra (TiO6
  // octahedra); the molecular view clears them.
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    (async () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      try {
        const snapshot = await fetchSnapshot(resolvedSrc);
        if (cancelled || !rendererRef.current) return;
        // The renderer is shared by every mode, and loadSnapshot keeps what
        // the previous structure's overlays left behind (the app's pipeline
        // resets them on every apply; this backdrop bypasses the pipeline).
        // Without this, a crystal's boundary images, periodic-image atoms,
        // coordination bonds and polyhedra stay drawn over the next
        // structure. Clear them before loading, then give the new structure
        // its own bonds.
        renderer.setDrawingBoundary(null);
        renderer.setBondPeriodicImages(null);
        renderer.clearPolyhedra();
        renderer.loadSnapshot(snapshot);
        renderer.updateBondsExt(
          snapshot.bonds,
          snapshot.bondOrders,
          snapshot.positions,
          snapshot.elements,
          snapshot.nAtoms,
        );
        // A backdrop shows the structure only: no cell box or cell-axes
        // inset. A structure without a cell does not replace the previous
        // one's either, so hide them on every load.
        renderer.setCellVisible(false);
        renderer.setCellAxesVisible(false);
        // loadSnapshot may reset the clear color — keep the dark hero bg.
        renderer.setBackgroundColor(HERO_BG);

        if (kind === "polyhedra") {
          renderer.setRepresentationType?.("atoms");
          const { executePolyhedronGenerator } =
            await import("../../../src/pipeline/executors/polyhedronGenerator");
          const { executeCoordinationGenerator } =
            await import("../../../src/pipeline/executors/coordinationGenerator");
          const { generateDrawingBoundaryImages } =
            await import("../../../src/logic/cellBoundaryImages");
          if (cancelled || !rendererRef.current) return;
          const particle: any = {
            type: "particle",
            source: snapshot,
            sourceNodeId: "hero",
            indices: null,
            scaleOverrides: null,
            opacityOverrides: null,
            colorOverrides: null,
            representationOverride: null,
            drawingBoundary: generateDrawingBoundaryImages(snapshot),
          };
          const coordinationParams: any = {
            type: "coordination_generator",
            // Exclude Sr (Z=38) so perovskite shows the classic corner-sharing
            // TiO6 octahedra, not SrO12 cuboctahedra. Harmless for quartz
            // (no Sr present) where Si centers give SiO4 tetrahedra.
            excludedCenters: [38],
            excludedLigands: [],
            cutoffTolerance: 1.15,
            boundaryMode: "complete",
          };
          const coordinationResult = executeCoordinationGenerator(
            coordinationParams,
            new Map([["particle", [particle]]]) as any,
          );
          const coordination = coordinationResult.get("coordination");
          const coordinationBond = coordinationResult.get("bond") as any;
          renderer.setDrawingBoundary(particle.drawingBoundary);
          if (coordinationBond) {
            renderer.setBondPeriodicImages(coordinationBond.periodicImages ?? null);
            renderer.updateBondsExt(
              coordinationBond.bondIndices,
              coordinationBond.bondOrders,
              coordinationBond.positions,
              coordinationBond.elements,
              coordinationBond.nAtoms,
            );
          }
          const params: any = {
            type: "polyhedron_generator",
            opacity: 0.72,
            showEdges: true,
            edgeColor: "#cfd6df",
            edgeWidth: 2,
          };
          const mesh = coordination
            ? executePolyhedronGenerator(
                params,
                new Map([["coordination", [coordination]]]) as any,
              ).get("mesh")
            : null;
          if (mesh && !cancelled && rendererRef.current) {
            renderer.loadPolyhedra(mesh);
          }
        } else if (kind === "cartoon") {
          // Ribbon backbone + a translucent molecular-surface mesh overlay
          // (reuses the polyhedra overlay slot, which renders any MeshData).
          renderer.setRepresentationType?.("cartoon");
          const { buildSurfaceMeshData } = await import("../../../src/renderer/alphaSurface");
          if (cancelled || !rendererRef.current) return;
          const surface = buildSurfaceMeshData(
            snapshot.positions,
            snapshot.nAtoms,
            3.0,
            "#3ad6c8",
            0.16,
          );
          if (surface && !cancelled && rendererRef.current) {
            renderer.loadPolyhedra(surface);
          }
        } else {
          renderer.setRepresentationType?.("atoms");
        }
        setReady(true);
      } catch {
        /* decorative backdrop — ignore load failures */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, resolvedSrc, mode]);

  return (
    <div
      ref={containerRef}
      className={styles.heroViewer}
      data-ready={ready ? "true" : "false"}
      aria-hidden="true"
    />
  );
}
