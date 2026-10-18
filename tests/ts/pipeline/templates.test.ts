import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PIPELINE_TEMPLATES } from "@/pipeline/templates";
import { evaluateSelection, evaluateBondSelection } from "@/pipeline/selection";
import { parseVolumetric } from "@/pipeline/executors/parseVolumetric";
import { executeIsosurface } from "@/pipeline/executors/isosurface";
import { BOHR_TO_ANGSTROM } from "@/pipeline/executors/parseCube";
import { buildAlphaSdf, buildSurfaceMeshData } from "@/renderer/alphaSurface";
import type { Snapshot } from "@/types";
import type {
  LoadStructureParams,
  LoadVolumetricParams,
  IsosurfaceParams,
  AddBondParams,
  ColorParams,
  FilterParams,
  ModifyParams,
  RepresentationParams,
  SurfaceMeshParams,
  BoundaryCompletionParams,
  WrapParams,
  PipelineNodeType,
  PipelineData,
  MeshData,
} from "@/pipeline/types";
import { canConnect } from "@/pipeline/types";

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

  it("wires every edge between ports that exist and accept each other", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const { nodes, edges } = t.create();
      const typeOf = new Map(nodes.map((n) => [n.id, n.type as PipelineNodeType]));
      for (const e of edges) {
        expect(
          canConnect(
            typeOf.get(e.source)!,
            e.sourceHandle ?? null,
            typeOf.get(e.target)!,
            e.targetHandle ?? null,
          ),
          `template "${t.id}": edge ${e.source}.${e.sourceHandle} → ${e.target}.${e.targetHandle} is not a valid connection`,
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

  /**
   * 1hsg.pdb read straight from its ATOM/HETATM columns — the labels
   * ("<resName><resSeq>") and positions the selection DSL sees, without the
   * WASM parser.
   */
  function read1hsg(): { snapshot: Snapshot; labels: string[] } {
    const text = readFileSync(resolve(__dirname, "../../fixtures/1hsg.pdb"), "utf8");
    const labels: string[] = [];
    const positions: number[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
      labels.push(line.slice(17, 20).trim() + line.slice(22, 26).trim());
      positions.push(
        parseFloat(line.slice(30, 38)),
        parseFloat(line.slice(38, 46)),
        parseFloat(line.slice(46, 54)),
      );
    }
    const nAtoms = labels.length;
    return {
      labels,
      snapshot: {
        nAtoms,
        nBonds: 0,
        nFileBonds: 0,
        positions: new Float32Array(positions),
        elements: new Uint8Array(nAtoms).fill(6),
        bonds: new Uint32Array(0),
        bondOrders: null,
        box: null,
        boxOrigin: null,
        atomChainIds: null,
        atomBFactors: null,
      },
    };
  }

  function queryOf(nodeId: string): string {
    const node = protein!.create().nodes.find((n) => n.id === nodeId)!;
    return (node.data.params as FilterParams).query;
  }

  it("is registered", () => {
    expect(protein).toBeDefined();
  });

  it("loads the cell-less 1hsg.pdb fixture", () => {
    const { nodes } = protein!.create();
    const loader = nodes.find((n) => n.type === "load_structure");
    const params = loader!.data.params as LoadStructureParams;
    expect(params.fileName).toBe("1hsg.pdb");
    expect(params.hasCell).toBe(false);
  });

  it("splits 1HSG into disjoint polymer / drug / contact-water / bulk-water branches", () => {
    const { snapshot, labels } = read1hsg();
    expect(snapshot.nAtoms).toBe(1686);
    const select = (id: string) => evaluateSelection(queryOf(id), snapshot, labels)!;
    const polymer = select("protein-filter");
    const ligand = select("ligand-filter");
    const contact = select("water-filter");
    const bulk = select("bulk-water-filter");

    expect(polymer.size).toBe(1514);
    // Indinavir's 45 atoms: "MK1" ends in a digit, so this only matches
    // through labelMatchesResname's prefix rule.
    expect(ligand.size).toBe(45);
    expect(contact.size).toBe(7);
    expect(bulk.size).toBe(120);

    // Every atom lands in exactly one branch, so no two branches compete
    // over how the same atom is drawn.
    const seen = new Set<number>();
    for (const set of [polymer, ligand, contact, bulk]) {
      for (const i of set) {
        expect(seen.has(i), `atom ${i} selected by two branches`).toBe(false);
        seen.add(i);
      }
    }
    expect(seen.size).toBe(snapshot.nAtoms);
  });

  it("hides the polymer's bonds by atom index: the HETATM block starts at 1514", () => {
    const { labels } = read1hsg();
    // The bond query keeps only bonds with both ends at atom_index >= 1514;
    // that block must be indinavir followed by water (which has no bonds).
    expect(labels.slice(0, 1514).every((l) => !l.startsWith("MK1") && !l.startsWith("HOH"))).toBe(
      true,
    );
    expect(labels.slice(1514, 1559).every((l) => l.startsWith("MK1"))).toBe(true);
    expect(labels.slice(1559).every((l) => l.startsWith("HOH"))).toBe(true);

    const { nodes, edges } = protein!.create();
    const bondFilter = nodes.find((n) => n.id === "bond-filter")!;
    expect((bondFilter.data.params as FilterParams).bond_query).toBe("not both atom_index >= 1514");
    // A drug bond (both ends >= 1514) survives; a backbone bond is selected
    // for hiding.
    const selected = evaluateBondSelection(
      (bondFilter.data.params as FilterParams).bond_query!,
      new Uint32Array([0, 1, 1514, 1515]),
      new Uint8Array(1686).fill(6),
      2,
      1686,
    );
    expect(selected).toEqual(new Set([0]));
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "addbond-1", target: "bond-filter" }),
        expect.objectContaining({ source: "bond-filter", target: "bond-modify" }),
        expect.objectContaining({
          source: "bond-modify",
          target: "viewport-1",
          targetHandle: "bond",
        }),
      ]),
    );
    const bondModify = nodes.find((n) => n.id === "bond-modify")!;
    expect((bondModify.data.params as ModifyParams).opacity).toBe(0);
  });

  it("hides the polymer atoms and the bulk water, keeps the contact water", () => {
    const { nodes } = protein!.create();
    const opacity = (id: string) =>
      (nodes.find((n) => n.id === id)!.data.params as ModifyParams).opacity;
    expect(opacity("protein-modify")).toBe(0);
    expect(opacity("bulk-water-modify")).toBe(0);
    expect(opacity("water-modify")).toBe(1);
  });

  it("requests the cartoon ribbon via a representation node in 'both' mode", () => {
    const { nodes } = protein!.create();
    const rep = nodes.find((n) => n.type === "representation");
    expect(rep).toBeDefined();
    expect((rep!.data.params as RepresentationParams).mode).toBe("both");
  });

  it("wires no cell into the Viewport", () => {
    const { edges } = protein!.create();
    expect(edges.some((e) => e.targetHandle === "cell")).toBe(false);
  });
});

describe("PIPELINE_TEMPLATES surface mesh", () => {
  const surface = PIPELINE_TEMPLATES.find((t) => t.id === "surface_mesh");

  it("is registered", () => {
    expect(surface).toBeDefined();
  });

  it("loads the cell-less au_nanoparticle.xyz fixture", () => {
    const { nodes } = surface!.create();
    const loader = nodes.find((n) => n.type === "load_structure");
    expect(loader).toBeDefined();
    const params = loader!.data.params as LoadStructureParams;
    expect(params.fileName).toBe("au_nanoparticle.xyz");
    expect(params.hasCell).toBe(false);
  });

  it("includes a surface_mesh node with a probe just above the Au–Au distance", () => {
    const { nodes } = surface!.create();
    const mesh = nodes.find((n) => n.type === "surface_mesh");
    expect(mesh).toBeDefined();
    const params = mesh!.data.params as SurfaceMeshParams;
    expect(params.alphaRadius).toBe(3.0);
    expect(params.color).toBe("#38bdf8");
    expect(params.opacity).toBeGreaterThan(0);
    expect(params.opacity).toBeLessThan(1);
  });

  it("envelopes the whole nanoparticle in one closed mesh", () => {
    const text = readFileSync(resolve(__dirname, "../../fixtures/au_nanoparticle.xyz"), "utf8");
    const lines = text.trim().split("\n");
    const nAtoms = parseInt(lines[0], 10);
    expect(nAtoms).toBe(1385);
    const positions = new Float32Array(nAtoms * 3);
    lines.slice(2).forEach((line, i) => {
      const [, x, y, z] = line.trim().split(/\s+/);
      positions.set([parseFloat(x), parseFloat(y), parseFloat(z)], i * 3);
    });

    const { nodes } = surface!.create();
    const params = nodes.find((n) => n.type === "surface_mesh")!.data.params as SurfaceMeshParams;
    const sdf = buildAlphaSdf(positions, nAtoms, params.alphaRadius);
    // Closed: no grid point on the outer faces lies inside the envelope.
    const { res } = sdf;
    for (let z = 0; z < res; z++) {
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          if (x > 0 && x < res - 1 && y > 0 && y < res - 1 && z > 0 && z < res - 1) continue;
          expect(sdf.sdf[z * res * res + y * res + x]).toBeGreaterThan(0);
        }
      }
    }
    const mesh = buildSurfaceMeshData(positions, nAtoms, params.alphaRadius, "#38bdf8", 0.45);
    expect(mesh.positions.length).toBeGreaterThan(0);
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

describe("PIPELINE_TEMPLATES esp", () => {
  const esp = PIPELINE_TEMPLATES.find((t) => t.id === "esp");
  const fixture = (name: string) =>
    readFileSync(resolve(__dirname, "../../fixtures", name), "utf8");

  it("is registered", () => {
    expect(esp).toBeDefined();
  });

  it("loads the caffeine_b3lyp.sdf structure and both DFT grids", () => {
    const { nodes } = esp!.create();
    const loader = nodes.find((n) => n.type === "load_structure");
    expect((loader!.data.params as LoadStructureParams).fileName).toBe("caffeine_b3lyp.sdf");
    const grids = Object.fromEntries(
      nodes
        .filter((n) => n.type === "load_volumetric")
        .map((n) => [n.id, (n.data.params as LoadVolumetricParams).fileName]),
    );
    expect(grids).toEqual({
      "volumetric-1": "caffeine_b3lyp_density.cube",
      "volumetric-esp": "caffeine_b3lyp_esp.cube",
    });
  });

  it("contours the density and colors it by the potential", () => {
    const { nodes, edges } = esp!.create();
    const iso = nodes.find((n) => n.type === "isosurface")!;
    const params = iso.data.params as IsosurfaceParams;
    // 0.002 e/Bohr³ is the conventional molecular-surface contour; a density
    // has no negative lobe to draw.
    expect(params.isoLevel).toBe(0.002);
    expect(params.showNegative).toBe(false);
    expect(params.colorMode).toBe("volume");
    expect(params.colormap).toBe("rwb");
    expect(params.colorRange).toEqual([-0.04, 0.04]);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "volumetric-1",
          target: iso.id,
          sourceHandle: "volumetric",
          targetHandle: "volumetric",
        }),
        expect.objectContaining({
          source: "volumetric-esp",
          target: iso.id,
          sourceHandle: "volumetric",
          targetHandle: "colorVolumetric",
        }),
        expect.objectContaining({
          source: iso.id,
          target: "viewport-1",
          sourceHandle: "mesh",
          targetHandle: "mesh",
        }),
      ]),
    );
    // Only the two grids feed the isosurface — it overlays the structure
    // because the files share a frame, not because the graph joins them.
    expect(
      edges
        .filter((e) => e.target === iso.id)
        .map((e) => e.source)
        .sort(),
    ).toEqual(["volumetric-1", "volumetric-esp"]);
  });

  it("ships grids registered with the structure on one shared lattice", () => {
    const density = parseVolumetric(
      "caffeine_b3lyp_density.cube",
      fixture("caffeine_b3lyp_density.cube"),
    );
    const potential = parseVolumetric(
      "caffeine_b3lyp_esp.cube",
      fixture("caffeine_b3lyp_esp.cube"),
    );
    expect([potential.nx, potential.ny, potential.nz]).toEqual([
      density.nx,
      density.ny,
      density.nz,
    ]);
    expect(Array.from(potential.origin)).toEqual(Array.from(density.origin));
    expect(Array.from(potential.step)).toEqual(Array.from(density.step));

    // The cube's own atom block sits on the SDF's coordinates (same frame).
    const sdfLines = fixture("caffeine_b3lyp.sdf").split("\n");
    const firstAtom = sdfLines[4];
    const sdfO = [0, 10, 20].map((c) => parseFloat(firstAtom.slice(c, c + 10)));
    const cubeAtom = fixture("caffeine_b3lyp_density.cube").split("\n")[6].trim().split(/\s+/);
    const cubeO = cubeAtom.slice(2, 5).map((v) => parseFloat(v) * BOHR_TO_ANGSTROM);
    expect(parseInt(cubeAtom[0], 10)).toBe(8);
    for (let k = 0; k < 3; k++) expect(cubeO[k]).toBeCloseTo(sdfO[k], 3);
  });

  it("draws a closed surface painted both red and blue with the template's params", () => {
    const { nodes } = esp!.create();
    const params = nodes.find((n) => n.type === "isosurface")!.data.params as IsosurfaceParams;
    const inputs = new Map<string, PipelineData[]>([
      [
        "volumetric",
        [parseVolumetric("caffeine_b3lyp_density.cube", fixture("caffeine_b3lyp_density.cube"))],
      ],
      [
        "colorVolumetric",
        [parseVolumetric("caffeine_b3lyp_esp.cube", fixture("caffeine_b3lyp_esp.cube"))],
      ],
    ]);
    const mesh = executeIsosurface(params, inputs).get("mesh") as MeshData;
    const nVerts = mesh.positions.length / 3;
    expect(nVerts).toBeGreaterThan(1000);

    // Count clearly red (negative potential) and clearly blue (positive)
    // vertices: an ESP map of caffeine has both.
    let red = 0;
    let blue = 0;
    for (let v = 0; v < nVerts; v++) {
      const [r, , b] = [mesh.colors[v * 4], mesh.colors[v * 4 + 1], mesh.colors[v * 4 + 2]];
      if (r - b > 0.4) red++;
      if (b - r > 0.4) blue++;
    }
    expect(red).toBeGreaterThan(nVerts * 0.02);
    expect(blue).toBeGreaterThan(nVerts * 0.02);
  });

  it("takes caffeine's bonds from the SDF bond block rather than inferring them", () => {
    const { nodes } = esp!.create();
    const addBond = nodes.find((n) => n.type === "add_bond")!;
    expect((addBond.data.params as AddBondParams).bondSource).toBe("structure");
  });
});

describe("PIPELINE_TEMPLATES coarse grained", () => {
  const cg = PIPELINE_TEMPLATES.find((t) => t.id === "coarse_grained");

  it("is registered", () => {
    expect(cg).toBeDefined();
  });

  it("overlays the all-atom and coarse-grained fixtures from two loaders", () => {
    const { nodes } = cg!.create();
    const loaders = nodes.filter((n) => n.type === "load_structure");
    expect(loaders).toHaveLength(2);
    const fileNames = loaders.map((n) => (n.data.params as LoadStructureParams).fileName);
    expect(fileNames).toEqual(["1ubq.pdb", "1ubq_cg.pdb"]);
  });

  it("puts the all-atom loader first so ds.local.loadText fills it", () => {
    // `useMeganeLocal.applyResult` targets the FIRST load_structure node; the
    // coarse-grained beads are loaded into "loader-cg" by node id instead.
    const { nodes } = cg!.create();
    const first = nodes.find((n) => n.type === "load_structure")!;
    expect(first.id).toBe("loader-aa");
    expect(nodes.some((n) => n.id === "loader-cg")).toBe(true);
  });

  it("ghosts the all-atom model semi-transparent", () => {
    const { nodes, edges } = cg!.create();
    const filter = nodes.find((n) => n.id === "aa-filter")!;
    expect((filter.data.params as FilterParams).query).toBe('resname != "HOH"');

    const atomModify = nodes.find((n) => n.id === "aa-modify")!;
    const params = atomModify.data.params as ModifyParams;
    expect(params.opacity).toBeGreaterThan(0);
    expect(params.opacity).toBeLessThan(1);
    expect(params.scale).toBe(1);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: filter.id, target: atomModify.id }),
        expect.objectContaining({
          source: atomModify.id,
          target: "viewport-1",
          sourceHandle: "out",
          targetHandle: "particle",
        }),
      ]),
    );
  });

  it("hides the crystallographic waters through their own branch", () => {
    // A Modify behind a Filter writes opacity only at the selected indices and
    // leaves everything else at 1.0 — so without this second branch the 58
    // waters would render fully opaque over the ghost they were filtered out
    // of. Both branches together cover every atom of the snapshot.
    const { nodes, edges } = cg!.create();
    const waterFilter = nodes.find((n) => n.id === "water-filter")!;
    expect((waterFilter.data.params as FilterParams).query).toBe('resname == "HOH"');
    expect((nodes.find((n) => n.id === "water-modify")!.data.params as ModifyParams).opacity).toBe(
      0,
    );

    const queries = nodes
      .filter((n) => n.type === "filter")
      .map((n) => (n.data.params as FilterParams).query);
    expect(queries).toEqual(['resname != "HOH"', 'resname == "HOH"']);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "wrap-1", target: "water-filter" }),
        expect.objectContaining({ source: "water-filter", target: "water-modify" }),
        expect.objectContaining({
          source: "water-modify",
          target: "viewport-1",
          sourceHandle: "out",
          targetHandle: "particle",
        }),
      ]),
    );
  });

  it("gives the all-atom branch no AddBond node", () => {
    // 1UBQ is an X-ray entry with no CONECT for the protein, and opening a
    // `.pdb` forces every AddBond reachable from that loader to "structure"
    // (syncAddBondSourceForLoader) — so one here could only ever warn
    // "No bonds found". Only the CG branch, whose file does carry CONECT,
    // gets a bond node.
    const { nodes, edges } = cg!.create();
    const bondNodes = nodes.filter((n) => n.type === "add_bond");
    expect(bondNodes.map((n) => n.id)).toEqual(["cg-addbond"]);
    expect(edges.some((e) => e.source === "aa-filter" && e.target === "cg-addbond")).toBe(false);
  });

  it("scales the beads up and colors them so they read over the ghost", () => {
    const { nodes } = cg!.create();
    const beadModify = nodes.find((n) => n.id === "cg-modify")!;
    const beadParams = beadModify.data.params as ModifyParams;
    // Rendered radius is vdW(C) 1.7 A x BALL_STICK_ATOM_SCALE 0.3 x scale;
    // scale 3.2 gives ~1.6 A, under half the 3.94 A closest approach of two
    // non-bonded beads, so the chain stays a string of separate beads.
    expect(beadParams.scale).toBeGreaterThan(1);
    expect(beadParams.scale * 1.7 * 0.3).toBeLessThan(3.94 / 2);
    expect(beadParams.opacity).toBe(1);

    const color = nodes.find((n) => n.type === "color")!;
    const colorParams = color.data.params as ColorParams;
    expect(colorParams.mode).toBe("uniform");
    expect(colorParams.uniformColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("takes the bead chain from the CG file's CONECT records", () => {
    const { nodes, edges } = cg!.create();
    const cgBond = nodes.find((n) => n.id === "cg-addbond")!;
    expect((cgBond.data.params as AddBondParams).bondSource).toBe("structure");
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "loader-cg",
          target: cgBond.id,
          sourceHandle: "particle",
          targetHandle: "particle",
        }),
        expect.objectContaining({
          source: cgBond.id,
          target: "viewport-1",
          sourceHandle: "bond",
          targetHandle: "bond",
        }),
      ]),
    );
  });

  it("leaves 1ubq's crystallographic cell unwired", () => {
    const { edges } = cg!.create();
    expect(edges.some((e) => e.targetHandle === "cell")).toBe(false);
  });
});

describe("PIPELINE_TEMPLATES wrap toggle", () => {
  it("every structure template carries a pass-through wrap node", () => {
    for (const id of ["molecule", "solid", "surface_mesh", "protein", "esp", "coarse_grained"]) {
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
    for (const id of [
      "molecule",
      "molecular_crystal",
      "solid",
      "surface_mesh",
      "protein",
      "esp",
      "coarse_grained",
    ]) {
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
