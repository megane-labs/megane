import { describe, it, expect } from "vitest";
import { PIPELINE_TEMPLATES } from "@/pipeline/templates";
import type {
  LoadStructureParams,
  FilterParams,
  ModifyParams,
  RepresentationParams,
  SurfaceMeshParams,
  BoundaryCompletionParams,
  WrapParams,
} from "@/pipeline/types";

describe("PIPELINE_TEMPLATES", () => {
  it("is non-empty", () => {
    expect(PIPELINE_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("each template has required fields", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(typeof t.create).toBe("function");
    }
  });

  it("each template has unique id", () => {
    const ids = PIPELINE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each template creates valid nodes and edges", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const { nodes, edges } = t.create();
      expect(nodes.length).toBeGreaterThan(0);

      // All edges reference existing node IDs
      const ids = new Set(nodes.map((n) => n.id));
      for (const e of edges) {
        expect(
          ids.has(e.source),
          `template "${t.id}": edge source "${e.source}" not in nodes`,
        ).toBe(true);
        expect(
          ids.has(e.target),
          `template "${t.id}": edge target "${e.target}" not in nodes`,
        ).toBe(true);
      }
    }
  });

  it("each template has a viewport node", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const { nodes } = t.create();
      expect(
        nodes.some((n) => n.type === "viewport"),
        `template "${t.id}" missing viewport node`,
      ).toBe(true);
    }
  });
});

describe("PIPELINE_TEMPLATES protein", () => {
  const protein = PIPELINE_TEMPLATES.find((t) => t.id === "protein");

  it("is registered", () => {
    expect(protein).toBeDefined();
  });

  it("loads the 1ubq.pdb fixture", () => {
    const { nodes } = protein!.create();
    const loader = nodes.find((n) => n.type === "load_structure");
    expect(loader).toBeDefined();
    expect((loader!.data.params as LoadStructureParams).fileName).toBe("1ubq.pdb");
  });

  it("filters protein and water by residue name", () => {
    const { nodes } = protein!.create();
    const queries = nodes
      .filter((n) => n.type === "filter")
      .map((n) => (n.data.params as FilterParams).query);
    expect(queries).toContain('resname != "HOH"');
    expect(queries).toContain('resname == "HOH"');
  });

  it("hides protein atoms (opacity 0) and shows water semi-transparent (opacity 0.5)", () => {
    const { nodes } = protein!.create();
    const opacities = nodes
      .filter((n) => n.type === "modify")
      .map((n) => (n.data.params as ModifyParams).opacity);
    expect(opacities).toContain(0);
    expect(opacities).toContain(0.5);
  });

  it("requests the cartoon ribbon via a representation node in 'both' mode", () => {
    const { nodes } = protein!.create();
    const rep = nodes.find((n) => n.type === "representation");
    expect(rep).toBeDefined();
    expect((rep!.data.params as RepresentationParams).mode).toBe("both");
  });
});

describe("PIPELINE_TEMPLATES surface mesh", () => {
  const surface = PIPELINE_TEMPLATES.find((t) => t.id === "surface_mesh");

  it("is registered", () => {
    expect(surface).toBeDefined();
  });

  it("loads the quartz_sio2_2x2x2.xyz fixture with cell metadata", () => {
    const { nodes } = surface!.create();
    const loader = nodes.find((n) => n.type === "load_structure");
    expect(loader).toBeDefined();
    const params = loader!.data.params as LoadStructureParams;
    expect(params.fileName).toBe("quartz_sio2_2x2x2.xyz");
    expect(params.hasCell).toBe(true);
  });

  it("includes a surface_mesh node with documented default params", () => {
    const { nodes } = surface!.create();
    const mesh = nodes.find((n) => n.type === "surface_mesh");
    expect(mesh).toBeDefined();
    const params = mesh!.data.params as SurfaceMeshParams;
    expect(params.alphaRadius).toBe(3.0);
    expect(params.color).toBe("#4488ff");
    expect(params.opacity).toBe(0.5);
  });

  it("wires loader→symmetry→wrap→surface_mesh on particle and surface_mesh→viewport on mesh", () => {
    const { nodes, edges } = surface!.create();
    const loader = nodes.find((n) => n.type === "load_structure")!;
    const symmetry = nodes.find((n) => n.type === "symmetry")!;
    const wrap = nodes.find((n) => n.type === "wrap")!;
    const mesh = nodes.find((n) => n.type === "surface_mesh")!;
    const viewport = nodes.find((n) => n.type === "viewport")!;

    const loaderToSymmetry = edges.find(
      (e) =>
        e.source === loader.id &&
        e.target === symmetry.id &&
        e.sourceHandle === "particle" &&
        e.targetHandle === "particle",
    );
    expect(loaderToSymmetry).toBeDefined();

    const symmetryToWrap = edges.find(
      (e) =>
        e.source === symmetry.id &&
        e.target === wrap.id &&
        e.sourceHandle === "particle" &&
        e.targetHandle === "particle",
    );
    expect(symmetryToWrap).toBeDefined();

    const wrapToMesh = edges.find(
      (e) =>
        e.source === wrap.id &&
        e.target === mesh.id &&
        e.sourceHandle === "particle" &&
        e.targetHandle === "particle",
    );
    expect(wrapToMesh).toBeDefined();

    const meshToViewport = edges.find(
      (e) =>
        e.source === mesh.id &&
        e.target === viewport.id &&
        e.sourceHandle === "mesh" &&
        e.targetHandle === "mesh",
    );
    expect(meshToViewport).toBeDefined();
  });
});

describe("PIPELINE_TEMPLATES molecular crystal", () => {
  const molecularCrystal = PIPELINE_TEMPLATES.find((t) => t.id === "molecular_crystal");

  it("is registered with a wrapped glycine CIF", () => {
    expect(molecularCrystal).toBeDefined();
    const { nodes } = molecularCrystal!.create();
    const loader = nodes.find((n) => n.type === "load_structure")!;
    const wrap = nodes.find((n) => n.type === "wrap")!;
    expect((loader.data.params as LoadStructureParams).fileName).toBe("glycine_csd.cif");
    expect((wrap.data.params as WrapParams).mode).toBe("wrap");
  });

  it("completes finite molecular components from bond topology and Drawing Boundary", () => {
    const { nodes, edges } = molecularCrystal!.create();
    const wrap = nodes.find((n) => n.type === "wrap")!;
    const addBond = nodes.find((n) => n.type === "add_bond")!;
    const drawingBoundary = nodes.find((n) => n.type === "drawing_boundary")!;
    const completion = nodes.find((n) => n.type === "boundary_completion")!;
    const viewport = nodes.find((n) => n.type === "viewport")!;

    expect((completion.data.params as BoundaryCompletionParams).mode).toBe("components");
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: wrap.id,
          target: addBond.id,
          sourceHandle: "particle",
          targetHandle: "particle",
        }),
        expect.objectContaining({
          source: wrap.id,
          target: drawingBoundary.id,
          sourceHandle: "particle",
          targetHandle: "particle",
        }),
        expect.objectContaining({
          source: drawingBoundary.id,
          target: completion.id,
          sourceHandle: "particle",
          targetHandle: "particle",
        }),
        expect.objectContaining({
          source: addBond.id,
          target: completion.id,
          sourceHandle: "bond",
          targetHandle: "bond",
        }),
        expect.objectContaining({
          source: completion.id,
          target: viewport.id,
          sourceHandle: "particle",
          targetHandle: "particle",
        }),
        expect.objectContaining({
          source: completion.id,
          target: viewport.id,
          sourceHandle: "bond",
          targetHandle: "bond",
        }),
      ]),
    );
  });
});

describe("PIPELINE_TEMPLATES solid", () => {
  it("places Wrap before Drawing Boundary and sends completed coordination bonds to Viewport", () => {
    const solid = PIPELINE_TEMPLATES.find((t) => t.id === "solid")!;
    const { nodes, edges } = solid.create();
    const loader = nodes.find((n) => n.type === "load_structure")!;
    const symmetry = nodes.find((n) => n.type === "symmetry")!;
    const wrap = nodes.find((n) => n.type === "wrap")!;
    const drawingBoundary = nodes.find((n) => n.type === "drawing_boundary")!;
    const coordination = nodes.find((n) => n.type === "coordination_generator")!;
    const viewport = nodes.find((n) => n.type === "viewport")!;

    expect((wrap.data.params as WrapParams).mode).toBe("none");
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: loader.id, target: symmetry.id }),
        expect.objectContaining({ source: symmetry.id, target: wrap.id }),
        expect.objectContaining({ source: wrap.id, target: drawingBoundary.id }),
        expect.objectContaining({ source: drawingBoundary.id, target: coordination.id }),
        expect.objectContaining({
          source: coordination.id,
          target: viewport.id,
          sourceHandle: "bond",
          targetHandle: "bond",
        }),
      ]),
    );
  });
});

describe("PIPELINE_TEMPLATES wrap toggle", () => {
  it("every structure template carries a pass-through wrap node", () => {
    for (const id of ["molecule", "solid", "surface_mesh", "protein"]) {
      const template = PIPELINE_TEMPLATES.find((t) => t.id === id)!;
      const { nodes } = template.create();
      const wrap = nodes.find((n) => n.type === "wrap");
      expect(wrap, `template "${id}" missing wrap node`).toBeDefined();
      expect(wrap!.data.params).toEqual({ type: "wrap", mode: "none" });
    }
  });
});

describe("PIPELINE_TEMPLATES symmetry expansion", () => {
  it("every structure template carries an expand-mode symmetry node feeding wrap", () => {
    for (const id of ["molecule", "molecular_crystal", "solid", "surface_mesh", "protein"]) {
      const template = PIPELINE_TEMPLATES.find((t) => t.id === id)!;
      const { nodes, edges } = template.create();
      const symmetry = nodes.find((n) => n.type === "symmetry");
      expect(symmetry, `template "${id}" missing symmetry node`).toBeDefined();
      expect(symmetry!.data.params).toEqual({ type: "symmetry", mode: "expand" });
      const loader = nodes.find((n) => n.type === "load_structure")!;
      const wrap = nodes.find((n) => n.type === "wrap")!;
      expect(
        edges.some(
          (e) =>
            e.source === loader.id &&
            e.target === symmetry!.id &&
            e.sourceHandle === "particle" &&
            e.targetHandle === "particle",
        ),
        `template "${id}" must wire loader→symmetry`,
      ).toBe(true);
      expect(
        edges.some(
          (e) =>
            e.source === symmetry!.id &&
            e.target === wrap.id &&
            e.sourceHandle === "particle" &&
            e.targetHandle === "particle",
        ),
        `template "${id}" must wire symmetry→wrap`,
      ).toBe(true);
    }
  });
});
