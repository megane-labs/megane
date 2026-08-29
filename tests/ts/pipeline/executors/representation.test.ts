import { describe, it, expect } from "vitest";
import { executeRepresentation } from "@/pipeline/executors/representation";
import type { ParticleData, PipelineData, RepresentationParams } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    positions: new Float32Array(6),
    elements: new Uint8Array([6, 6]),
    bonds: new Uint32Array(),
    bondOrders: null,
  } as unknown as Snapshot;
}

function makeParticle(opts: Partial<ParticleData> = {}): ParticleData {
  return {
    type: "particle",
    source: makeSnapshot(),
    sourceNodeId: "src",
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
    ...opts,
  };
}

function inputs(particle: ParticleData): Map<string, PipelineData[]> {
  return new Map([["in", [particle]]]);
}

describe("executeRepresentation", () => {
  it("returns no output when there is no input", () => {
    const params: RepresentationParams = { type: "representation", mode: "atoms" };
    const out = executeRepresentation(params, new Map());
    expect(out.size).toBe(0);
  });

  it("tags the outgoing particle with the chosen mode", () => {
    const params: RepresentationParams = { type: "representation", mode: "cartoon" };
    const out = executeRepresentation(params, inputs(makeParticle()));
    const result = out.get("out") as ParticleData;
    expect(result.representationOverride).toBe("cartoon");
  });

  it("tags the outgoing particle with the licorice mode", () => {
    const params: RepresentationParams = { type: "representation", mode: "licorice" };
    const out = executeRepresentation(params, inputs(makeParticle()));
    const result = out.get("out") as ParticleData;
    expect(result.representationOverride).toBe("licorice");
  });

  it("overwrites an existing upstream override (downstream wins)", () => {
    const params: RepresentationParams = { type: "representation", mode: "surface" };
    const upstream = makeParticle({ representationOverride: "atoms" });
    const out = executeRepresentation(params, inputs(upstream));
    const result = out.get("out") as ParticleData;
    expect(result.representationOverride).toBe("surface");
  });

  it("does not mutate the upstream particle", () => {
    const params: RepresentationParams = { type: "representation", mode: "both" };
    const upstream = makeParticle();
    executeRepresentation(params, inputs(upstream));
    expect(upstream.representationOverride).toBeNull();
  });

  it("tags the outgoing particle with the line mode", () => {
    const params: RepresentationParams = { type: "representation", mode: "line" };
    const out = executeRepresentation(params, inputs(makeParticle()));
    const result = out.get("out") as ParticleData;
    expect(result.representationOverride).toBe("line");
  });

  it("tags the outgoing particle with the illustrative mode", () => {
    const params: RepresentationParams = { type: "representation", mode: "illustrative" };
    const out = executeRepresentation(params, inputs(makeParticle()));
    const result = out.get("out") as ParticleData;
    expect(result.representationOverride).toBe("illustrative");
  });
});
