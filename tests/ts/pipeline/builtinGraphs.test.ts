/**
 * Pins the exact node / edge structure of every built-in graph — the default
 * pipelines and each template — so a change to `graphFactory.ts`,
 * `defaultParams`, or a template body cannot silently change what a user gets.
 *
 * Positions are deliberately not pinned: every consumer lays these graphs out
 * with `getLayoutedElements`, which places nodes from sizes and edges alone.
 * The last test proves that property for each graph.
 *
 * Each node is pinned as `"<id> <type> <params JSON without type>"` (the JSON
 * pins key order too, which is what a saved `.megane.json` writes) and each
 * edge as `"<source>.<handle> -> <target>.<handle>"`, in array order.
 */
import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "@/pipeline/execute";
import {
  createDefaultPipeline,
  createMinimalStructurePipeline,
  createEmptyPipeline,
  createDemoPipeline,
} from "@/pipeline/defaults";
import { PIPELINE_TEMPLATES } from "@/pipeline/templates";
import { getLayoutedElements } from "@/pipeline/layout";

type Graph = { nodes: Node<PipelineNodeData>[]; edges: Edge[] };

const GRAPHS: Record<string, () => Graph> = {
  createDefaultPipeline,
  createMinimalStructurePipeline,
  createEmptyPipeline,
  createDemoPipeline,
  ...Object.fromEntries(PIPELINE_TEMPLATES.map((t) => [`tpl:${t.id}`, t.create])),
};

const PINNED: Record<string, { nodes: string[]; edges: string[] }> = {
  createDefaultPipeline: {
    nodes: [
      'loader-1 load_structure {"fileName":"caffeine_water.pdb","hasTrajectory":false,"hasCell":true}',
      'traj-1 load_trajectory {"fileName":"caffeine_water_vibration.xtc"}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'replicate-1 replicate {"nx":1,"ny":1,"nz":1}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "loader-1.cell -> replicate-1.cell",
      "loader-1.particle -> traj-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> replicate-1.particle",
      "replicate-1.particle -> addbond-1.particle",
      "replicate-1.particle -> viewport-1.particle",
      "replicate-1.cell -> viewport-1.cell",
      "addbond-1.bond -> viewport-1.bond",
      "traj-1.trajectory -> symmetry-1.trajectory",
      "symmetry-1.trajectory -> wrap-1.trajectory",
      "wrap-1.trajectory -> replicate-1.trajectory",
      "replicate-1.trajectory -> viewport-1.trajectory",
    ],
  },
  createMinimalStructurePipeline: {
    nodes: [
      'loader-1 load_structure {"fileName":"","hasTrajectory":false,"hasCell":false}',
      'traj-1 load_trajectory {"fileName":""}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'replicate-1 replicate {"nx":1,"ny":1,"nz":1}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "loader-1.cell -> replicate-1.cell",
      "loader-1.particle -> traj-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> replicate-1.particle",
      "replicate-1.particle -> addbond-1.particle",
      "replicate-1.particle -> viewport-1.particle",
      "replicate-1.cell -> viewport-1.cell",
      "addbond-1.bond -> viewport-1.bond",
      "traj-1.trajectory -> symmetry-1.trajectory",
      "symmetry-1.trajectory -> wrap-1.trajectory",
      "wrap-1.trajectory -> replicate-1.trajectory",
      "replicate-1.trajectory -> viewport-1.trajectory",
    ],
  },
  createEmptyPipeline: {
    nodes: [
      'loader-1 load_structure {"fileName":"","hasTrajectory":false,"hasCell":false}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'replicate-1 replicate {"nx":1,"ny":1,"nz":1}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "loader-1.cell -> replicate-1.cell",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> replicate-1.particle",
      "replicate-1.particle -> addbond-1.particle",
      "addbond-1.bond -> viewport-1.bond",
      "replicate-1.particle -> viewport-1.particle",
      "replicate-1.cell -> viewport-1.cell",
      "loader-1.trajectory -> symmetry-1.trajectory",
      "symmetry-1.trajectory -> wrap-1.trajectory",
      "wrap-1.trajectory -> replicate-1.trajectory",
      "replicate-1.trajectory -> viewport-1.trajectory",
    ],
  },
  createDemoPipeline: {
    nodes: [
      'loader-1 load_structure {"fileName":"protein.pdb","hasTrajectory":false,"hasCell":false}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'filter-1 filter {"query":"element == \\"C\\""}',
      'modify-1 modify {"scale":1.5,"opacity":0.8}',
      'filter-2 filter {"query":"element == \\"N\\""}',
      'modify-2 modify {"scale":0.5,"opacity":0.6}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> filter-1.in",
      "filter-1.out -> modify-1.in",
      "loader-1.particle -> filter-2.in",
      "filter-2.out -> modify-2.in",
      "modify-1.out -> viewport-1.particle",
      "modify-2.out -> viewport-1.particle",
      "loader-1.particle -> addbond-1.particle",
      "addbond-1.bond -> viewport-1.bond",
    ],
  },
  "tpl:molecule": {
    nodes: [
      'loader-1 load_structure {"fileName":"caffeine_water.pdb","hasTrajectory":false,"hasCell":true}',
      'traj-1 load_trajectory {"fileName":"caffeine_water_vibration.xtc"}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "loader-1.particle -> traj-1.particle",
      "traj-1.trajectory -> symmetry-1.trajectory",
      "symmetry-1.particle -> wrap-1.particle",
      "symmetry-1.trajectory -> wrap-1.trajectory",
      "wrap-1.particle -> addbond-1.particle",
      "wrap-1.particle -> viewport-1.particle",
      "loader-1.cell -> viewport-1.cell",
      "addbond-1.bond -> viewport-1.bond",
      "wrap-1.trajectory -> viewport-1.trajectory",
    ],
  },
  "tpl:molecular_crystal": {
    nodes: [
      'loader-1 load_structure {"fileName":"glycine_csd.cif","hasTrajectory":false,"hasCell":true}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"wrap"}',
      'addbond-1 add_bond {"bondSource":"distance"}',
      'drawing-boundary-1 drawing_boundary {"xMin":0,"xMax":1,"yMin":0,"yMax":1,"zMin":0,"zMax":1}',
      'boundary-completion-1 boundary_completion {"mode":"components"}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> addbond-1.particle",
      "wrap-1.particle -> drawing-boundary-1.particle",
      "drawing-boundary-1.particle -> boundary-completion-1.particle",
      "addbond-1.bond -> boundary-completion-1.bond",
      "boundary-completion-1.particle -> viewport-1.particle",
      "boundary-completion-1.bond -> viewport-1.bond",
      "loader-1.cell -> viewport-1.cell",
    ],
  },
  "tpl:solid": {
    nodes: [
      'loader-1 load_structure {"fileName":"perovskite_srtio3_3x3x3.xyz","hasTrajectory":false,"hasCell":true}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'drawing-boundary-1 drawing_boundary {"xMin":0,"xMax":1,"yMin":0,"yMax":1,"zMin":0,"zMax":1}',
      'coordination-1 coordination_generator {"excludedCenters":[],"excludedLigands":[],"cutoffTolerance":1.15,"boundaryMode":"complete"}',
      'polyhedron-1 polyhedron_generator {"opacity":0.5,"showEdges":false,"edgeColor":"#dddddd","edgeWidth":3}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> drawing-boundary-1.particle",
      "drawing-boundary-1.particle -> coordination-1.particle",
      "drawing-boundary-1.particle -> viewport-1.particle",
      "loader-1.cell -> viewport-1.cell",
      "coordination-1.bond -> viewport-1.bond",
      "coordination-1.coordination -> polyhedron-1.coordination",
      "polyhedron-1.mesh -> viewport-1.mesh",
    ],
  },
  "tpl:surface_mesh": {
    nodes: [
      'loader-1 load_structure {"fileName":"au_nanoparticle.xyz","hasTrajectory":false,"hasCell":false}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'surface-1 surface_mesh {"alphaRadius":3,"color":"#38bdf8","opacity":0.45}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> surface-1.particle",
      "wrap-1.particle -> viewport-1.particle",
      "surface-1.mesh -> viewport-1.mesh",
    ],
  },
  "tpl:protein": {
    nodes: [
      'loader-1 load_structure {"fileName":"1hsg.pdb","hasTrajectory":false,"hasCell":false}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'protein-filter filter {"query":"resname != \\"HOH\\" and resname != \\"MK1\\""}',
      'protein-modify modify {"scale":1,"opacity":0}',
      'protein-rep representation {"mode":"both"}',
      'ligand-filter filter {"query":"resname == \\"MK1\\""}',
      'water-filter filter {"query":"resname == \\"HOH\\" and within 3.5 of (resname == \\"MK1\\")"}',
      'water-modify modify {"scale":0.7,"opacity":1}',
      'bulk-water-filter filter {"query":"resname == \\"HOH\\" and not within 3.5 of (resname == \\"MK1\\")"}',
      'bulk-water-modify modify {"scale":1,"opacity":0}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'bond-filter filter {"query":"","bond_query":"not both atom_index >= 1514"}',
      'bond-modify modify {"scale":1,"opacity":0}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> protein-filter.in",
      "protein-filter.out -> protein-modify.in",
      "protein-modify.out -> protein-rep.in",
      "protein-rep.out -> viewport-1.particle",
      "wrap-1.particle -> ligand-filter.in",
      "ligand-filter.out -> viewport-1.particle",
      "wrap-1.particle -> water-filter.in",
      "water-filter.out -> water-modify.in",
      "water-modify.out -> viewport-1.particle",
      "wrap-1.particle -> bulk-water-filter.in",
      "bulk-water-filter.out -> bulk-water-modify.in",
      "bulk-water-modify.out -> viewport-1.particle",
      "wrap-1.particle -> addbond-1.particle",
      "addbond-1.bond -> bond-filter.in",
      "bond-filter.out -> bond-modify.in",
      "bond-modify.out -> viewport-1.bond",
    ],
  },
  "tpl:esp": {
    nodes: [
      'loader-1 load_structure {"fileName":"caffeine_b3lyp.sdf","hasTrajectory":false,"hasCell":false}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'addbond-1 add_bond {"bondSource":"structure"}',
      'volumetric-1 load_volumetric {"fileName":"caffeine_b3lyp_density.cube"}',
      'volumetric-esp load_volumetric {"fileName":"caffeine_b3lyp_esp.cube"}',
      'isosurface-1 isosurface {"isoLevel":0.002,"color":"#e5e7eb","opacity":0.8,"showNegative":false,"negativeColor":"#ef4444","colorMode":"volume","colormap":"rwb","colorRange":[-0.04,0.04]}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-1.particle -> symmetry-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> addbond-1.particle",
      "wrap-1.particle -> viewport-1.particle",
      "addbond-1.bond -> viewport-1.bond",
      "volumetric-1.volumetric -> isosurface-1.volumetric",
      "volumetric-esp.volumetric -> isosurface-1.colorVolumetric",
      "isosurface-1.mesh -> viewport-1.mesh",
    ],
  },
  "tpl:coarse_grained": {
    nodes: [
      'loader-aa load_structure {"fileName":"1ubq.pdb","hasTrajectory":false,"hasCell":true}',
      'symmetry-1 symmetry {"mode":"expand"}',
      'wrap-1 wrap {"mode":"none"}',
      'aa-filter filter {"query":"resname != \\"HOH\\""}',
      'aa-modify modify {"scale":1,"opacity":0.3}',
      'water-filter filter {"query":"resname == \\"HOH\\""}',
      'water-modify modify {"scale":1,"opacity":0}',
      'loader-cg load_structure {"fileName":"1ubq_cg.pdb","hasTrajectory":false,"hasCell":false}',
      'cg-modify modify {"scale":3.2,"opacity":1}',
      'cg-color color {"mode":"uniform","uniformColor":"#f97316"}',
      'cg-addbond add_bond {"bondSource":"structure"}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "loader-aa.particle -> symmetry-1.particle",
      "symmetry-1.particle -> wrap-1.particle",
      "wrap-1.particle -> aa-filter.in",
      "aa-filter.out -> aa-modify.in",
      "aa-modify.out -> viewport-1.particle",
      "wrap-1.particle -> water-filter.in",
      "water-filter.out -> water-modify.in",
      "water-modify.out -> viewport-1.particle",
      "loader-cg.particle -> cg-modify.in",
      "cg-modify.out -> cg-color.in",
      "cg-color.out -> viewport-1.particle",
      "loader-cg.particle -> cg-addbond.particle",
      "cg-addbond.bond -> viewport-1.bond",
    ],
  },
  "tpl:streaming": {
    nodes: [
      'streaming-1 streaming {"connected":false}',
      'viewport-1 viewport {"perspective":false,"cellAxesVisible":true,"pivotMarkerVisible":true}',
    ],
    edges: [
      "streaming-1.particle -> viewport-1.particle",
      "streaming-1.bond -> viewport-1.bond",
      "streaming-1.trajectory -> viewport-1.trajectory",
      "streaming-1.cell -> viewport-1.cell",
    ],
  },
};

function describeNode(n: Node<PipelineNodeData>): string {
  const { type, ...params } = n.data.params;
  return `${n.id} ${type} ${JSON.stringify(params)}`;
}

describe("built-in pipeline graphs", () => {
  it("pins a structure for every graph and no stale entries", () => {
    expect(Object.keys(GRAPHS).sort()).toEqual(Object.keys(PINNED).sort());
  });

  for (const [name, create] of Object.entries(GRAPHS)) {
    describe(name, () => {
      it("has the pinned nodes and edges", () => {
        const { nodes, edges } = create();
        expect(nodes.map(describeNode)).toEqual(PINNED[name].nodes);
        expect(
          edges.map((e) => `${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`),
        ).toEqual(PINNED[name].edges);
      });

      it("uses consistent xyflow fields", () => {
        const { nodes, edges } = create();
        for (const n of nodes) {
          expect(Object.keys(n).sort()).toEqual(["data", "id", "position", "type"]);
          expect(n.type).toBe(n.data.params.type);
          expect(n.data).toEqual({ params: n.data.params, enabled: true });
        }
        expect(edges.map((e) => e.id)).toEqual(edges.map((_, i) => `e${i + 1}`));
      });

      it("returns fresh objects on every call", () => {
        const a = create();
        const b = create();
        expect(b).toStrictEqual(a);
        a.nodes.forEach((n, i) => {
          expect(n).not.toBe(b.nodes[i]);
          expect(n.data.params).not.toBe(b.nodes[i].data.params);
          expect(n.position).not.toBe(b.nodes[i].position);
        });
      });

      it("is laid out from its edges, whatever the input positions", () => {
        const { nodes, edges } = create();
        const scattered = nodes.map((n, i) => ({ ...n, position: { x: 97 * i, y: -31 * i } }));
        expect(getLayoutedElements(scattered, edges)).toStrictEqual(
          getLayoutedElements(nodes, edges),
        );
      });
    });
  }
});
