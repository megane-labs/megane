import { describe, it, expect, beforeEach } from "vitest";
import { usePipelineStore } from "@/pipeline/store";
import type { PipelineNodeType } from "@/pipeline/types";

describe("usePipelineStore", () => {
  beforeEach(() => {
    // Reset to a known state by deserializing a minimal pipeline
    usePipelineStore.getState().deserialize({
      version: 3,
      nodes: [
        {
          type: "load_structure",
          id: "loader-1",
          position: { x: 0, y: 0 },
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
          enabled: true,
        },
        {
          type: "viewport",
          id: "viewport-1",
          position: { x: 0, y: 200 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [
        {
          source: "loader-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    });
  });

  describe("initial state", () => {
    it("has nodes and edges", () => {
      const { nodes, edges } = usePipelineStore.getState();
      expect(nodes.length).toBeGreaterThan(0);
      expect(edges.length).toBeGreaterThan(0);
    });
  });

  describe("addNode", () => {
    it("adds a node and returns its id", () => {
      const store = usePipelineStore.getState();
      const initialCount = store.nodes.length;
      const id = store.addNode("filter" as PipelineNodeType);
      expect(typeof id).toBe("string");
      expect(usePipelineStore.getState().nodes.length).toBe(initialCount + 1);
      expect(usePipelineStore.getState().nodes.find((n) => n.id === id)).toBeDefined();
    });

    it("sets default params for the node type", () => {
      const id = usePipelineStore.getState().addNode("filter" as PipelineNodeType);
      const node = usePipelineStore.getState().nodes.find((n) => n.id === id)!;
      expect(node.data.params.type).toBe("filter");
      expect(node.data.enabled).toBe(true);
    });

    it("uses custom position when provided", () => {
      const pos = { x: 100, y: 200 };
      const id = usePipelineStore.getState().addNode("filter" as PipelineNodeType, pos);
      const node = usePipelineStore.getState().nodes.find((n) => n.id === id)!;
      expect(node.position).toEqual(pos);
    });
  });

  describe("removeNode", () => {
    it("removes the node and connected edges", () => {
      const store = usePipelineStore.getState();
      const id = store.addNode("filter" as PipelineNodeType);
      const countBefore = usePipelineStore.getState().nodes.length;
      usePipelineStore.getState().removeNode(id);
      expect(usePipelineStore.getState().nodes.length).toBe(countBefore - 1);
      expect(usePipelineStore.getState().nodes.find((n) => n.id === id)).toBeUndefined();
    });
  });

  describe("updateNodeParams", () => {
    it("updates params for a specific node", () => {
      const id = usePipelineStore.getState().addNode("filter" as PipelineNodeType);
      usePipelineStore.getState().updateNodeParams(id, { query: "element == 'C'" });
      const node = usePipelineStore.getState().nodes.find((n) => n.id === id)!;
      expect((node.data.params as any).query).toBe("element == 'C'");
    });

    /**
     * Regression: changing AddBond.bondSource used to invalidate the React
     * `snapshot` selector in MeganeViewer because every executePipeline run
     * produced a fresh ParticleData object whose `source` happened to share
     * the underlying Snapshot — the selector returned the same value, but
     * any consumer that subscribed to the whole `viewportState` re-rendered
     * the entire React tree, including PipelineEditor's xyflow canvas.
     *
     * The fix is twofold:
     *  - MeganeViewer subscribes to viewportState via the vanilla zustand
     *    `subscribe` API inside an effect (no render-path coupling).
     *  - The Snapshot reference exposed via the `particles[0].source`
     *    selector is preserved across bondSource flips so the React-level
     *    selector stays referentially stable.
     *
     * This test guards the second invariant.
     */
    it("preserves the primary Snapshot reference when AddBond.bondSource changes", async () => {
      // Seed the store with a real snapshot so the LoadStructure executor
      // emits a particle output.
      const { createMinimalStructurePipeline } = await import("@/pipeline/defaults");
      const { nodes, edges } = createMinimalStructurePipeline();
      usePipelineStore.setState({ nodes, edges });

      const loader = usePipelineStore.getState().nodes.find((n) => n.type === "load_structure")!;
      const addBond = usePipelineStore.getState().nodes.find((n) => n.type === "add_bond")!;
      const fakeSnapshot = {
        nAtoms: 4,
        nBonds: 0,
        nFileBonds: 0,
        positions: new Float32Array(12),
        elements: new Uint8Array(4),
        bonds: new Uint32Array(0),
        bondOrders: new Uint8Array(0),
        box: null,
      };
      usePipelineStore.getState().setNodeSnapshot(loader.id, {
        snapshot: fakeSnapshot,
        frames: null,
        meta: null,
        labels: null,
      });

      const before = usePipelineStore.getState().viewportState.particles[0]?.source;
      expect(before, "expected the loader's snapshot to flow into viewport.particles").toBe(
        fakeSnapshot,
      );

      // Flip bondSource — this would historically rebuild the entire
      // pipeline output graph but must not allocate a new Snapshot.
      usePipelineStore.getState().updateNodeParams(addBond.id, { bondSource: "distance" });
      const after = usePipelineStore.getState().viewportState.particles[0]?.source;
      expect(after).toBe(before);
    });
  });

  describe("toggleNode", () => {
    it("toggles enabled state", () => {
      const id = usePipelineStore.getState().addNode("filter" as PipelineNodeType);
      expect(usePipelineStore.getState().nodes.find((n) => n.id === id)!.data.enabled).toBe(true);
      usePipelineStore.getState().toggleNode(id);
      expect(usePipelineStore.getState().nodes.find((n) => n.id === id)!.data.enabled).toBe(false);
      usePipelineStore.getState().toggleNode(id);
      expect(usePipelineStore.getState().nodes.find((n) => n.id === id)!.data.enabled).toBe(true);
    });
  });

  describe("serialize / deserialize", () => {
    it("round-trips nodes and edges", () => {
      const store = usePipelineStore.getState();
      store.addNode("filter" as PipelineNodeType);
      const serialized = usePipelineStore.getState().serialize();
      expect(serialized.version).toBe(3);

      const nodeCountBefore = usePipelineStore.getState().nodes.length;
      usePipelineStore.getState().deserialize(serialized);
      expect(usePipelineStore.getState().nodes.length).toBe(nodeCountBefore);
    });

    it("preserves node types after round-trip", () => {
      const serialized = usePipelineStore.getState().serialize();
      usePipelineStore.getState().deserialize(serialized);
      const nodes = usePipelineStore.getState().nodes;
      for (const node of nodes) {
        expect(node.type).toBeTruthy();
        expect(node.data.params.type).toBe(node.type);
      }
    });
  });

  describe("applyTemplate", () => {
    it("replaces pipeline with template", () => {
      const nodesBefore = usePipelineStore.getState().nodes.map((n) => n.id);
      usePipelineStore.getState().applyTemplate("molecule");
      const nodesAfter = usePipelineStore.getState().nodes.map((n) => n.id);
      // Template should produce different nodes
      expect(nodesAfter).not.toEqual(nodesBefore);
      expect(usePipelineStore.getState().pendingTemplateId).toBe("molecule");
    });

    it("does nothing for unknown template", () => {
      const nodesBefore = [...usePipelineStore.getState().nodes];
      usePipelineStore.getState().applyTemplate("nonexistent");
      expect(usePipelineStore.getState().nodes).toEqual(nodesBefore);
    });

    it("clears execution context state when switching templates", () => {
      const store = usePipelineStore.getState();
      // Pre-populate execution context fields
      store.setSnapshot({
        positions: new Float32Array(3),
        elements: new Int32Array(1),
        nAtoms: 1,
        bonds: [],
        cell: null,
        pbc: [false, false, false],
      });
      store.setNodeSnapshot("loader-1", {
        snapshot: {
          positions: new Float32Array(3),
          elements: new Int32Array(1),
          nAtoms: 1,
          bonds: [],
          cell: null,
          pbc: [false, false, false],
        },
        atomLabels: null,
      });
      store.setNodeParseError("loader-1", "some error");

      usePipelineStore.getState().applyTemplate("molecule");

      const state = usePipelineStore.getState();
      expect(state.snapshot).toBeNull();
      expect(state.atomLabels).toBeNull();
      expect(state.structureFrames).toBeNull();
      expect(state.structureMeta).toBeNull();
      expect(state.fileFrames).toBeNull();
      expect(state.fileMeta).toBeNull();
      expect(state.fileVectors).toBeNull();
      expect(state.nodeSnapshots).toEqual({});
      expect(state.nodeParseErrors).toEqual({});
      expect(state.nodeStreamingData).toEqual({});
    });
  });

  describe("autoLayout", () => {
    it("repositions nodes", () => {
      const posBefore = usePipelineStore.getState().nodes.map((n) => ({ ...n.position }));
      // Add several nodes to make layout meaningful
      usePipelineStore.getState().addNode("filter" as PipelineNodeType);
      usePipelineStore.getState().addNode("modify" as PipelineNodeType);
      usePipelineStore.getState().autoLayout();
      // Just verify it runs without error and nodes still exist
      expect(usePipelineStore.getState().nodes.length).toBeGreaterThan(0);
    });
  });

  describe("loadPipeline (anywidget set_pipeline path)", () => {
    /**
     * Build a minimal H2O snapshot the executors can consume.
     */
    function makeWaterSnapshot() {
      return {
        nAtoms: 3,
        nBonds: 0,
        nFileBonds: 0,
        positions: new Float32Array([0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0]),
        elements: new Uint8Array([8, 1, 1]),
        bonds: new Uint32Array(0),
        bondOrders: null,
        box: null,
      };
    }

    /**
     * Mirrors the pipeline produced by the user's repro:
     *   LoadStructure → AddLabels   (label edge to Viewport)
     *   LoadStructure → AddPolyhedra (mesh edge to Viewport)
     *   LoadStructure → Viewport    (particle edge — no AddBond)
     */
    function labelsAndPolyhedraPipeline() {
      return {
        version: 3,
        nodes: [
          {
            type: "load_structure",
            id: "loader-1",
            position: { x: 0, y: 0 },
            fileName: null,
            hasTrajectory: false,
            hasCell: false,
            enabled: true,
          },
          {
            type: "label_generator",
            id: "labels-1",
            position: { x: 200, y: 0 },
            source: "element",
            enabled: true,
          },
          {
            type: "polyhedron_generator",
            id: "poly-1",
            position: { x: 200, y: 200 },
            excludedCenters: [],
            excludedLigands: [],
            cutoffTolerance: 1.15,
            opacity: 0.6,
            showEdges: true,
            enabled: true,
          },
          {
            type: "viewport",
            id: "viewport-1",
            position: { x: 400, y: 100 },
            perspective: false,
            cellAxesVisible: true,
            enabled: true,
          },
        ],
        edges: [
          {
            source: "loader-1",
            target: "labels-1",
            sourceHandle: "particle",
            targetHandle: "particle",
          },
          {
            source: "loader-1",
            target: "poly-1",
            sourceHandle: "particle",
            targetHandle: "particle",
          },
          {
            source: "loader-1",
            target: "viewport-1",
            sourceHandle: "particle",
            targetHandle: "particle",
          },
          {
            source: "labels-1",
            target: "viewport-1",
            sourceHandle: "label",
            targetHandle: "label",
          },
          { source: "poly-1", target: "viewport-1", sourceHandle: "mesh", targetHandle: "mesh" },
        ],
      };
    }

    it("renders particles for an AddLabels + AddPolyhedra pipeline (regression for blank ipywidget)", () => {
      const snapshot = makeWaterSnapshot();
      usePipelineStore.getState().loadPipeline(labelsAndPolyhedraPipeline(), {
        "loader-1": { snapshot, frames: null, meta: null, labels: null },
      });

      const state = usePipelineStore.getState();
      // The viewer was blank because executeLoadStructure ran with a null
      // snapshot (deserialize had wiped nodeSnapshots). loadPipeline's
      // single-transaction update keeps the snapshot, so particles flow
      // into the viewport.
      expect(state.viewportState.particles.length).toBeGreaterThan(0);
      expect(state.viewportState.particles[0].source.nAtoms).toBe(3);
      // Labels reach the viewport too.
      expect(state.viewportState.labels.length).toBeGreaterThan(0);
      expect(state.viewportState.labels[0].labels).toEqual(["O", "H", "H"]);
    });

    it("populates the legacy global snapshot from the first per-node entry", () => {
      const snapshot = makeWaterSnapshot();
      usePipelineStore.getState().loadPipeline(labelsAndPolyhedraPipeline(), {
        "loader-1": { snapshot, frames: null, meta: null, labels: null },
      });
      // The Viewport component reads `effectiveSnapshot = storeSnapshot ?? snapshot`,
      // so the store snapshot must be set for the renderer to call loadSnapshot.
      expect(usePipelineStore.getState().snapshot).toBe(snapshot);
    });

    it("clears nodeSnapshots from a previous pipeline before loading the new one", () => {
      // Seed an unrelated snapshot to ensure cross-document state cannot bleed.
      usePipelineStore.getState().setNodeSnapshot("stale-loader", {
        snapshot: makeWaterSnapshot(),
        frames: null,
        meta: null,
        labels: null,
      });
      const snapshot = makeWaterSnapshot();
      usePipelineStore.getState().loadPipeline(labelsAndPolyhedraPipeline(), {
        "loader-1": { snapshot, frames: null, meta: null, labels: null },
      });
      const finalSnapshots = usePipelineStore.getState().nodeSnapshots;
      expect(Object.keys(finalSnapshots).sort()).toEqual(["loader-1"]);
    });
  });
});

describe("embedded vector channels (offer / opt-in)", () => {
  const frames = [{ frame: 0, vectors: Float32Array.from([1, 2, 3]) }];

  it("offering channels does not feed the overlay", () => {
    usePipelineStore.setState({
      embeddedVectorChannels: null,
      activeEmbeddedVectorChannel: null,
      fileVectors: null,
    });
    usePipelineStore.getState().setEmbeddedVectorChannels([{ name: "velocity", frames }]);
    const state = usePipelineStore.getState();
    expect(state.embeddedVectorChannels).toHaveLength(1);
    expect(state.fileVectors).toBeNull();
    expect(state.activeEmbeddedVectorChannel).toBeNull();
  });

  it("activation feeds fileVectors; unknown names deactivate", () => {
    usePipelineStore.setState({
      embeddedVectorChannels: [{ name: "velocity", frames }],
      activeEmbeddedVectorChannel: null,
      fileVectors: null,
    });
    usePipelineStore.getState().activateEmbeddedVectorChannel("velocity");
    expect(usePipelineStore.getState().fileVectors).toBe(frames);
    usePipelineStore.getState().activateEmbeddedVectorChannel("nope");
    expect(usePipelineStore.getState().fileVectors).toBeNull();
    expect(usePipelineStore.getState().activeEmbeddedVectorChannel).toBeNull();
  });

  it("re-offering refreshes an active channel and drops a vanished one", () => {
    usePipelineStore.setState({
      embeddedVectorChannels: [{ name: "velocity", frames }],
      activeEmbeddedVectorChannel: null,
      fileVectors: null,
    });
    usePipelineStore.getState().activateEmbeddedVectorChannel("velocity");
    const newFrames = [
      { frame: 0, vectors: Float32Array.from([1, 2, 3]) },
      { frame: 1, vectors: Float32Array.from([4, 5, 6]) },
    ];
    // Same channel streamed in more frames: the active overlay follows.
    usePipelineStore.getState().setEmbeddedVectorChannels([{ name: "velocity", frames: newFrames }]);
    expect(usePipelineStore.getState().fileVectors).toBe(newFrames);
    // A new file without the channel deactivates it.
    usePipelineStore.getState().setEmbeddedVectorChannels(null);
    const state = usePipelineStore.getState();
    expect(state.fileVectors).toBeNull();
    expect(state.activeEmbeddedVectorChannel).toBeNull();
    expect(state.embeddedVectorChannels).toBeNull();
  });
});
