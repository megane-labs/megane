import { describe, expect, it } from "vitest";
import { generateDrawingBoundaryImages } from "@/logic/cellBoundaryImages";
import { executeCoordinationGenerator } from "@/pipeline/executors/coordinationGenerator";
import { executePolyhedronGenerator } from "@/pipeline/executors/polyhedronGenerator";
import { executeViewport } from "@/pipeline/executors/viewport";
import type {
  BondData,
  CoordinationData,
  CoordinationGeneratorParams,
  MeshData,
  ParticleData,
  PipelineData,
  PolyhedronGeneratorParams,
} from "@/pipeline/types";
import type { Snapshot } from "@/types";

function makeSnapshot(elements: number[], positions: number[], box?: Float32Array): Snapshot {
  return {
    nAtoms: elements.length,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(),
    bondOrders: null,
    box: box ?? null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function makeParticle(elements: number[], positions: number[], box?: Float32Array): ParticleData {
  return {
    type: "particle",
    source: makeSnapshot(elements, positions, box),
    sourceNodeId: "src",
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
}

function coordinationParams(
  extra: Partial<CoordinationGeneratorParams> = {},
): CoordinationGeneratorParams {
  return {
    type: "coordination_generator",
    excludedCenters: [],
    excludedLigands: [],
    centerQuery: "",
    neighborQuery: "",
    cutoffTolerance: 1.15,
    boundaryMode: "complete",
    ...extra,
  };
}

function polyhedronParams(
  extra: Partial<PolyhedronGeneratorParams> = {},
): PolyhedronGeneratorParams {
  return {
    type: "polyhedron_generator",
    opacity: 0.5,
    showEdges: false,
    edgeColor: "#dddddd",
    edgeWidth: 3,
    ...extra,
  };
}

function coordinate(
  particle: ParticleData,
  params = coordinationParams(),
): Map<string, PipelineData> {
  return executeCoordinationGenerator(params, new Map([["particle", [particle]]]));
}

function polyhedra(coordination: CoordinationData): Map<string, PipelineData> {
  return executePolyhedronGenerator(
    polyhedronParams(),
    new Map([["coordination", [coordination]]]),
  );
}

/** Idealized TiO6 octahedron with 2 Å Ti-O distances. */
function tio6(): ParticleData {
  return makeParticle(
    [22, 8, 8, 8, 8, 8, 8],
    [0, 0, 0, 2, 0, 0, -2, 0, 0, 0, 2, 0, 0, -2, 0, 0, 0, 2, 0, 0, -2],
  );
}

describe("Coordination -> Polyhedra responsibility split", () => {
  it("requires coordination input; Polyhedra never searches particles itself", () => {
    expect(executePolyhedronGenerator(polyhedronParams(), new Map()).size).toBe(0);
    expect(
      executePolyhedronGenerator(polyhedronParams(), new Map([["particle", [tio6()]]])).size,
    ).toBe(0);
  });

  it("auto-detects center-neighbor pairs in Coordination and only builds the hull in Polyhedra", () => {
    const coordination = coordinate(tio6()).get("coordination") as CoordinationData;
    const mesh = polyhedra(coordination).get("mesh") as MeshData;
    expect(coordination.nBonds).toBe(6);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it("never treats H, noble gases, or carbon as default neighbor atoms", () => {
    const positions: number[] = [0, 0, 0];
    const elements: number[] = [22];
    let offset = 0;
    for (const z of [1, 18, 6]) {
      for (let k = 0; k < 4; k++) {
        const angle = (k / 4) * Math.PI * 2;
        positions.push(Math.cos(angle) * 2, Math.sin(angle) * 2, offset * 0.5);
        elements.push(z);
        offset++;
      }
    }
    expect(coordinate(makeParticle(elements, positions)).size).toBe(0);
  });

  it("owns element exclusions and cutoff tolerance in Coordination", () => {
    expect(coordinate(tio6(), coordinationParams({ excludedCenters: [22] })).size).toBe(0);
    expect(coordinate(tio6(), coordinationParams({ excludedLigands: [8] })).size).toBe(0);
    expect(coordinate(tio6(), coordinationParams({ cutoffTolerance: 0.7 })).size).toBe(0);
  });

  it("does not build a polyhedron with fewer than four coordinated neighbor sites", () => {
    const coordination = coordinate(
      makeParticle([22, 8, 8, 8], [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]),
    ).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(3);
    expect(polyhedra(coordination).size).toBe(0);
  });

  it("applies minimum-image PBC in Coordination, not Polyhedra", () => {
    const box = new Float32Array([6, 0, 0, 0, 6, 0, 0, 0, 6]);
    const particle = makeParticle(
      [22, 8, 8, 8, 8, 8, 8],
      [3, 3, 3, 1, 3, 3, 5, 3, 3, 3, 1, 3, 3, 5, 3, 3, 3, 1, 3, 3, 5],
      box,
    );
    const coordination = coordinate(particle).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(6);
    expect(polyhedra(coordination).has("mesh")).toBe(true);
  });

  it("keeps distinct periodic images of the same ligand source", () => {
    const box = new Float32Array([3, 0, 0, 0, 10, 0, 0, 0, 10]);
    const particle = makeParticle([22, 8], [1.5, 5, 5, 0, 5, 5], box);

    const coordination = coordinate(particle).get("coordination") as CoordinationData;

    expect(coordination.nBonds).toBe(2);
    expect(Array.from(coordination.bondIndices)).toEqual([0, 1, 0, 2]);
    expect(coordination.outsideBoundaryImages?.sourceIndices).toEqual(new Uint32Array([1]));
    expect(coordination.outsideBoundaryImages?.latticeShifts).toEqual(new Int32Array([1, 0, 0]));
  });

  it("completes visible centers on the coordination/bond stream without Polyhedra", () => {
    const box = new Float32Array([4, 0, 0, 0, 4, 0, 0, 0, 4]);
    const particle = makeParticle(
      [22, 8, 8, 8, 8, 8, 8],
      [0.25, 2, 2, 3.75, 2, 2, 1.75, 2, 2, 0.25, 0.5, 2, 0.25, 3.5, 2, 0.25, 2, 0.5, 0.25, 2, 3.5],
      box,
    );
    particle.drawingBoundary = generateDrawingBoundaryImages(particle.source);

    const result = coordinate(particle, coordinationParams({ cutoffTolerance: 0.7 }));
    const coordination = result.get("coordination") as CoordinationData;
    const bonds = result.get("bond") as BondData;
    expect(coordination.outsideBoundaryImages?.elements).toEqual(new Uint8Array([8]));
    expect(Array.from(coordination.outsideBoundaryImages!.positions)).toEqual([-0.25, 2, 2]);
    expect(Array.from(coordination.outsideBoundaryImages!.sourceIndices)).toEqual([1]);
    expect(bonds.periodicImages).toBe(coordination.outsideBoundaryImages);
    expect(bonds.nBonds).toBe(6);
    // Every extended endpoint names its source atom: the boundary copies,
    // then the outside image of O1.
    const boundarySources = Array.from(particle.drawingBoundary.images.sourceIndices);
    expect(Array.from(bonds.ghostSourceIndices!)).toEqual([...boundarySources, 1]);
    expect(bonds.nAtoms - bonds.ghostSourceIndices!.length).toBe(7);
    // So a particle filter that keeps every atom keeps every coordination bond.
    const kept = executeViewport(
      { type: "viewport", perspective: false, cellAxesVisible: true },
      new Map<string, PipelineData[]>([
        ["particle", [{ ...particle, indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6]) }]],
        ["bond", [bonds]],
      ]),
    );
    expect(kept.bonds[0].nBonds).toBe(6);
    // This assertion intentionally does not execute Polyhedra: completing
    // outside-boundary neighbors is an independently renderable result.
  });

  it("builds polyhedra for center copies supplied by Drawing Boundary", () => {
    const box = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);
    const particle = makeParticle(
      [22, 8, 8, 8, 8, 8, 8],
      [0, 0, 0, 2, 0, 0, 8, 0, 0, 0, 2, 0, 0, 8, 0, 0, 0, 2, 0, 0, 8],
      box,
    );
    particle.drawingBoundary = generateDrawingBoundaryImages(particle.source);
    const coordination = coordinate(particle).get("coordination") as CoordinationData;
    const mesh = polyhedra(coordination).get("mesh") as MeshData;
    expect(coordination.nBonds).toBe(8 * 6);
    expect(Array.from(coordination.elements).filter((z) => z === 22)).toHaveLength(8);
    expect(mesh.indices.length).toBe(8 * 24);
  });

  it("the inside policy searches only the Drawing Boundary atom collection", () => {
    const box = new Float32Array([4, 0, 0, 0, 4, 0, 0, 0, 4]);
    const particle = makeParticle(
      [22, 8, 8, 8, 8, 8, 8],
      [0.25, 2, 2, 3.75, 2, 2, 1.75, 2, 2, 0.25, 0.5, 2, 0.25, 3.5, 2, 0.25, 2, 0.5, 0.25, 2, 3.5],
      box,
    );
    particle.drawingBoundary = generateDrawingBoundaryImages(particle.source);
    const result = coordinate(particle, coordinationParams({ boundaryMode: "inside" }));
    const coordination = result.get("coordination") as CoordinationData;
    const bonds = result.get("bond") as BondData;
    expect(coordination.outsideBoundaryImages).toBeNull();
    expect(bonds.periodicImages).toBeNull();
    expect(coordination.nBonds).toBe(5);
  });
});

/** Tetrahedron of four `ligand` atoms at `distance` Å around a `center` atom. */
function tetrahedron(center: number, ligand: number, distance: number): ParticleData {
  const d = distance / Math.sqrt(3);
  return makeParticle(
    [center, ligand, ligand, ligand, ligand],
    [0, 0, 0, d, d, d, d, -d, -d, -d, d, -d, -d, -d, d],
  );
}

describe("Coordination center/neighbor selection queries", () => {
  it("builds PO4 tetrahedra from a center query although P is not an auto-detected center", () => {
    expect(coordinate(tetrahedron(15, 8, 1.54)).size).toBe(0);
    const coordination = coordinate(
      tetrahedron(15, 8, 1.54),
      coordinationParams({ centerQuery: 'element == "P"' }),
    ).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(4);
    for (let pair = 0; pair < coordination.nBonds; pair++) {
      expect(coordination.bondIndices[pair * 2]).toBe(0);
    }
    const mesh = polyhedra(coordination).get("mesh") as MeshData;
    expect(mesh.indices.length).toBe(4 * 3);
  });

  it("accepts neighbors outside the auto-detected anion formers", () => {
    expect(coordinate(tetrahedron(26, 6, 1.9)).size).toBe(0);
    const coordination = coordinate(
      tetrahedron(26, 6, 1.9),
      coordinationParams({ neighborQuery: 'element == "C"' }),
    ).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(4);
  });

  it("a query replaces the exclusion list of its side", () => {
    const excluded = coordinationParams({ excludedCenters: [22] });
    expect(coordinate(tio6(), excluded).size).toBe(0);
    const coordination = coordinate(tio6(), {
      ...excluded,
      centerQuery: 'element == "Ti"',
    }).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(6);
  });

  it("picks individual atoms, not only elements", () => {
    const one = tio6();
    const positions = Array.from(one.source.positions);
    const shifted = positions.map((value, i) => (i % 3 === 0 ? value + 10 : value));
    const two = makeParticle(
      [...one.source.elements, ...one.source.elements],
      [...positions, ...shifted],
    );
    expect((coordinate(two).get("coordination") as CoordinationData).nBonds).toBe(12);
    const coordination = coordinate(two, coordinationParams({ centerQuery: "index == 7" })).get(
      "coordination",
    ) as CoordinationData;
    expect(coordination.nBonds).toBe(6);
    for (let pair = 0; pair < coordination.nBonds; pair++) {
      expect(coordination.bondIndices[pair * 2]).toBe(7);
    }
  });

  it('"all" makes every atom a candidate', () => {
    // P keeps its four O; each O (a center now) also finds P, a default neighbor.
    const coordination = coordinate(
      tetrahedron(15, 8, 1.54),
      coordinationParams({ centerQuery: "all" }),
    ).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(8);
  });

  it("an unparsable query matches nothing instead of falling back to auto-detection", () => {
    expect(coordinate(tio6(), coordinationParams({ centerQuery: "element ==" })).size).toBe(0);
    expect(coordinate(tio6(), coordinationParams({ neighborQuery: "element ==" })).size).toBe(0);
  });

  it("resolves residue queries through the atom labels", () => {
    const params = coordinationParams({
      centerQuery: 'resname == "PHO" and element == "P"',
    });
    const inputs = new Map<string, PipelineData[]>([["particle", [tetrahedron(15, 8, 1.54)]]]);
    expect(executeCoordinationGenerator(params, inputs).size).toBe(0);
    const labels = ["PHO1", "PHO1", "PHO1", "PHO1", "PHO1"];
    const coordination = executeCoordinationGenerator(params, inputs, labels).get(
      "coordination",
    ) as CoordinationData;
    expect(coordination.nBonds).toBe(4);
  });

  it("applies the queries under the inside policy too", () => {
    const coordination = coordinate(
      tetrahedron(15, 8, 1.54),
      coordinationParams({ centerQuery: 'element == "P"', boundaryMode: "inside" }),
    ).get("coordination") as CoordinationData;
    expect(coordination.nBonds).toBe(4);
  });
});
