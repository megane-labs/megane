/**
 * Drift guard for the JS/TS pipeline builder (`src/pipeline/builder.ts`).
 *
 * Every pipeline node type — the keys of `NODE_CATALOG`, which is typed as a
 * full `Record<PipelineNodeType, …>` and therefore lists the whole union —
 * must have a builder class that:
 *   - serializes to that node type,
 *   - exposes exactly the node's ports (`NODE_PORTS`) under its port aliases,
 *   - writes every default param and nothing the catalog does not document,
 *   - round-trips through `deserializePipeline` and the store's
 *     `deserialize()` / `serialize()` unchanged.
 *
 * There is deliberately no exclusion list: every node type is buildable.
 */
import { describe, it, expect } from "vitest";
import {
  BUILDER_NODE_CLASSES,
  Pipeline,
  PipelineNode,
  LoadStructure,
  LoadTrajectory,
  LoadVector,
  Filter,
  Symmetry,
  Wrap,
  Replicate,
  AddBonds,
  DrawingBoundary,
  AddCoordination,
  AddPolyhedra,
  SurfaceMesh,
  VectorOverlay,
  LoadVolumetric,
  Isosurface,
  LoadSpectrum,
  SpectrumPlot,
  Viewport,
} from "@/pipeline/builder";
import { NODE_CATALOG } from "@/pipeline/catalog";
import { NODE_PORTS, canConnect, defaultParams } from "@/pipeline/types";
import type { PipelineNodeType } from "@/pipeline/types";
import { deserializePipeline } from "@/pipeline/serialize";
import { usePipelineStore } from "@/pipeline/store";

const ALL_NODE_TYPES = Object.keys(NODE_CATALOG) as PipelineNodeType[];

/** Constructor arguments for node classes whose constructor needs some. */
const SAMPLE_ARGS: Partial<Record<PipelineNodeType, unknown[]>> = {
  load_structure: ["protein.pdb"],
  load_trajectory: ["run.dcd"],
  load_vector: ["forces.json"],
  load_volumetric: ["density.cube"],
  load_spectrum: ["ir.jdx"],
};

/**
 * Serialized keys the catalog does not document because they are a builder /
 * `PipelineViewer` convention rather than a node parameter: loaders write the
 * path as `fileUrl` too, so `PipelineViewer` can fetch it.
 */
const BUILDER_ONLY_KEYS = new Set(["type", "fileUrl"]);

/** Ephemeral params `serializePipeline` strips; never part of a saved node. */
const EPHEMERAL_KEYS = new Set(["bondFileData", "volumetricData", "spectrumData", "parseError"]);

function build(type: PipelineNodeType): PipelineNode {
  const Cls = BUILDER_NODE_CLASSES[type] as unknown as new (...args: unknown[]) => PipelineNode;
  return new Cls(...(SAMPLE_ARGS[type] ?? []));
}

function portHandles(accessor: PipelineNode["out"]): Record<string, string> {
  return Object.fromEntries(Object.keys(accessor).map((alias) => [alias, accessor[alias].handle]));
}

describe("builder covers every PipelineNodeType", () => {
  it("lists the same node types as NODE_PORTS and the builder registry", () => {
    expect(new Set(ALL_NODE_TYPES)).toEqual(new Set(Object.keys(NODE_PORTS)));
    expect(new Set(Object.keys(BUILDER_NODE_CLASSES))).toEqual(new Set(ALL_NODE_TYPES));
  });

  it.each(ALL_NODE_TYPES)("%s: builds a node of that type", (type) => {
    const node = build(type);
    expect(node).toBeInstanceOf(PipelineNode);
    expect(node.nodeType).toBe(type);
    expect(node._toSerializedParams().type).toBe(type);
  });

  it.each(ALL_NODE_TYPES)("%s: exposes exactly the node's ports", (type) => {
    const node = build(type);
    const outHandles = Object.values(portHandles(node.out));
    const inpHandles = Object.values(portHandles(node.inp));
    expect(new Set(outHandles)).toEqual(new Set(NODE_PORTS[type].outputs.map((p) => p.name)));
    expect(new Set(inpHandles)).toEqual(new Set(NODE_PORTS[type].inputs.map((p) => p.name)));
    // No two aliases may point at the same handle.
    expect(outHandles).toHaveLength(NODE_PORTS[type].outputs.length);
    expect(inpHandles).toHaveLength(NODE_PORTS[type].inputs.length);
  });

  it.each(ALL_NODE_TYPES)("%s: serializes every default param and only documented keys", (type) => {
    const params = build(type)._toSerializedParams();
    const documented = new Set(NODE_CATALOG[type].params.map((p) => p.jsonKey));
    for (const key of Object.keys(params)) {
      if (BUILDER_ONLY_KEYS.has(key)) continue;
      expect(documented, `${type}.${key} is not a documented param`).toContain(key);
    }
    for (const key of Object.keys(defaultParams(type))) {
      if (EPHEMERAL_KEYS.has(key)) continue;
      expect(params, `${type} does not serialize default param ${key}`).toHaveProperty(key);
    }
  });

  it.each(ALL_NODE_TYPES)("%s: round-trips through deserializePipeline", (type) => {
    const pipe = new Pipeline();
    const node = pipe.addNode(build(type));
    const { nodes } = deserializePipeline(pipe.toObject());
    const restored = nodes.find((n) => n.id === node._id);
    expect(restored?.type).toBe(type);
    expect(restored?.data.params).toMatchObject(node._toSerializedParams());
  });

  it.each(ALL_NODE_TYPES)("%s: round-trips through store deserialize/serialize", (type) => {
    const pipe = new Pipeline();
    const node = pipe.addNode(build(type));
    const store = usePipelineStore.getState();
    store.deserialize(pipe.toObject());
    const saved = usePipelineStore.getState().serialize();
    const restored = saved.nodes.find((n) => n.id === node._id);
    expect(restored).toMatchObject(node._toSerializedParams());
  });
});

describe("builder wiring for the newly covered nodes", () => {
  it("every edge of a pipeline using all of them passes canConnect and round-trips", () => {
    const pipe = new Pipeline();
    const s = pipe.addNode(new LoadStructure("crystal.cif"));
    const t = pipe.addNode(new LoadTrajectory("run.nc"));
    const sym = pipe.addNode(new Symmetry());
    const wrap = pipe.addNode(new Wrap({ mode: "wrap" }));
    const rep = pipe.addNode(new Replicate({ nx: 2, ny: 2, nz: 1 }));
    const b = pipe.addNode(new AddBonds());
    const db = pipe.addNode(new DrawingBoundary());
    const coord = pipe.addNode(new AddCoordination());
    const poly = pipe.addNode(new AddPolyhedra());
    const surf = pipe.addNode(new SurfaceMesh({ alphaRadius: 4 }));
    const vec = pipe.addNode(new LoadVector("forces.json"));
    const vo = pipe.addNode(new VectorOverlay());
    const vol = pipe.addNode(new LoadVolumetric("density.cube"));
    const esp = pipe.addNode(new LoadVolumetric("esp.cube"));
    const iso = pipe.addNode(new Isosurface({ colorMode: "volume" }));
    const spec = pipe.addNode(new LoadSpectrum("ir.jdx"));
    const plot = pipe.addNode(new SpectrumPlot({ reverseX: false }));
    const f = pipe.addNode(new Filter({ query: "element == 'O'" }));
    const v = pipe.addNode(new Viewport());

    pipe.addEdge(s.out.particle, t.inp.particle);
    pipe.addEdge(s.out.particle, sym.inp.particle);
    pipe.addEdge(t.out.traj, sym.inp.traj);
    pipe.addEdge(sym.out.particle, wrap.inp.particle);
    pipe.addEdge(sym.out.traj, wrap.inp.traj);
    pipe.addEdge(wrap.out.particle, rep.inp.particle);
    pipe.addEdge(wrap.out.traj, rep.inp.traj);
    pipe.addEdge(s.out.cell, rep.inp.cell);
    pipe.addEdge(rep.out.particle, v.inp.particle);
    pipe.addEdge(rep.out.cell, v.inp.cell);
    pipe.addEdge(rep.out.traj, v.inp.traj);
    pipe.addEdge(rep.out.particle, b.inp.particle);
    pipe.addEdge(b.out.bond, v.inp.bond);
    pipe.addEdge(rep.out.particle, db.inp.particle);
    pipe.addEdge(db.out.particle, coord.inp.particle);
    pipe.addEdge(coord.out.coordination, poly.inp.coordination);
    pipe.addEdge(poly.out.mesh, v.inp.mesh);
    pipe.addEdge(rep.out.particle, f.inp.particle);
    pipe.addEdge(f.out.particle, surf.inp.particle);
    pipe.addEdge(surf.out.mesh, v.inp.mesh);
    pipe.addEdge(vec.out.vector, vo.inp.vector);
    pipe.addEdge(vo.out.vector, v.inp.vector);
    pipe.addEdge(vol.out.volumetric, iso.inp.volumetric);
    pipe.addEdge(esp.out.volumetric, iso.inp.colorVolumetric);
    pipe.addEdge(iso.out.mesh, v.inp.mesh);
    pipe.addEdge(spec.out.spectrum, plot.inp.spectrum);

    const obj = pipe.toObject();
    const typeOf = new Map(obj.nodes.map((n) => [n.id, n.type]));
    for (const e of obj.edges) {
      expect(
        canConnect(typeOf.get(e.source)!, e.sourceHandle, typeOf.get(e.target)!, e.targetHandle),
        `${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`,
      ).toBe(true);
    }

    const { nodes, edges } = deserializePipeline(obj);
    // Every builder node survives; the bond and cell wiring already exists, so
    // normalization adds nothing.
    expect(nodes).toHaveLength(obj.nodes.length);
    expect(edges).toHaveLength(obj.edges.length);
    expect(nodes.find((n) => n.id === iso._id)?.data.params).toMatchObject({
      colorMode: "volume",
    });
    expect(nodes.find((n) => n.id === rep._id)?.data.params).toMatchObject({ nx: 2, ny: 2, nz: 1 });
  });
});
