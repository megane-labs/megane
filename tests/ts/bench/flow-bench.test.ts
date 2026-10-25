// @vitest-environment node
/**
 * The Flow benchmark's deterministic parts, in the normal test suite (no
 * network): the dataset is well-formed, every case's reference answer
 * (`bench/flow/golden.ts`) scores 1.0 when its flow is actually run — the
 * production engine, RDKit in Node, the recorded tool server — and every
 * counterexample is caught. Plus the scorer, runner, report and the request
 * the live runner sends, on stubs.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { FLOW_DATASET } from "../../../bench/flow/dataset";
import {
  embedSmilesInNode,
  environmentFor,
  getRDKit,
  manualStructure,
  readMolblock,
  recordedResult,
  referenceTools,
} from "../../../bench/flow/environment";
import { executeFlow, graphOf, summarize, type ExecutionResult } from "../../../bench/flow/execute";
import { GOLDEN, replyWith } from "../../../bench/flow/golden";
import { flowRequest, generateFlowLive } from "../../../bench/flow/providers";
import { aggregateFlow, flowToJSON, flowToMarkdown } from "../../../bench/flow/report";
import { runFlowDataset, selectCases } from "../../../bench/flow/runner";
import {
  FLOW_DIMENSION_WEIGHTS,
  scoreFlowResponse,
  scoreFormat,
  scoreSchema,
  type ExecuteFn,
} from "../../../bench/flow/scorer";
import { called, moleculeArg } from "../../../bench/flow/checks";
import type { FlowBenchCase } from "../../../bench/flow/types";
import { FLOW_NODE_TYPES } from "@/builder/flow/types";
import { moleculeToMolblock } from "@/builder/tools/payload";
import { PRESET_MOLECULES } from "@/builder/library/presets";

beforeAll(async () => {
  await getRDKit();
}, 60_000);

const byId = (id: string) => FLOW_DATASET.find((c) => c.id === id)!;

async function score(c: FlowBenchCase, reply: string, execute: ExecuteFn = executeFlow) {
  return scoreFlowResponse(reply, c, environmentFor(c.setup), execute);
}

describe("Flow dataset", () => {
  it("has unique ids, tags, and blocks Flow mode knows", () => {
    const ids = FLOW_DATASET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FLOW_DATASET.length).toBeGreaterThanOrEqual(20);
    for (const c of FLOW_DATASET) {
      expect(c.tags.length, c.id).toBeGreaterThan(0);
      const r = c.rubric;
      for (const t of [...(r.requiredBlocks ?? []), ...(r.forbiddenBlocks ?? [])]) {
        expect(FLOW_NODE_TYPES, c.id).toContain(t);
      }
    }
  });

  it("names only tools the reference server offers, and only where it is connected", () => {
    const names = referenceTools().map((t) => t.name);
    for (const c of FLOW_DATASET) {
      for (const t of c.rubric.requiredTools ?? []) {
        expect(names, c.id).toContain(t);
        expect(c.setup.tools, c.id).toBe(true);
      }
    }
  });

  it("has a reference and counterexamples for every case, and nothing else", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(FLOW_DATASET.map((c) => c.id).sort());
    for (const c of FLOW_DATASET)
      expect(GOLDEN[c.id].counterexamples.length, c.id).toBeGreaterThan(0);
  });
});

describe.each(FLOW_DATASET.map((c) => [c.id, c] as const))("golden: %s", (_id, c) => {
  it("the reference scores 1.0 when its flow is run", async () => {
    const s = await score(c, GOLDEN[c.id].reference());
    const failed = (["schema", "task", "params", "result", "format"] as const).flatMap((d) =>
      s[d].checks.filter((x) => !x.passed).map((x) => `${d}: ${x.label}`),
    );
    expect(failed, `${s.run?.error ?? ""} ${JSON.stringify(s.run?.output ?? null)}`).toEqual([]);
    expect(s.total).toBe(1);
  }, 120_000);

  it("every counterexample scores below 1.0, and one fails on what it builds", async () => {
    const scores = [];
    for (const ce of GOLDEN[c.id].counterexamples) {
      const s = await score(c, ce.reply());
      expect(s.total, ce.label).toBeLessThan(1);
      scores.push(s);
    }
    if (!c.rubric.prose) {
      expect(
        scores.some((s) => (s.result.score ?? 1) < 1),
        "no counterexample fails a result check",
      ).toBe(true);
    }
  }, 120_000);
});

describe("Flow benchmark environment", () => {
  it("embeds SMILES with RDKit as the Builder does, hydrogens added", async () => {
    const ethanol = await embedSmilesInNode("CCO");
    expect(summarize("", ethanol).elements).toEqual({ C: 2, O: 1, H: 6 });
    expect(ethanol.nBonds).toBe(8);
    await expect(embedSmilesInNode("C1CC")).rejects.toThrow();
  });

  it("reads a V2000 mol block, and refuses anything else", () => {
    const water = PRESET_MOLECULES.find((m) => m.id === "preset:water")!;
    const s = readMolblock(moleculeToMolblock(water));
    expect(summarize("", s)).toEqual({
      name: "",
      atoms: 3,
      elements: { O: 1, H: 2 },
      cell: false,
      bonds: { "H-O": 2 },
    });
    expect(() => readMolblock("not a mol block")).toThrow("V2000");
    const bad = moleculeToMolblock(water).replace(/ O  /, " Xx ");
    expect(() => readMolblock(bad)).toThrow("Unknown element");
  });

  it("builds the Manual structures and describes them to the assistant", () => {
    expect(summarize("", manualStructure("nacl-cell").snapshot).elements).toEqual({ Na: 4, Cl: 4 });
    expect(summarize("", manualStructure("cu-cell").snapshot).elements).toEqual({ Cu: 4 });
    const env = environmentFor({ document: "cu-cell", tools: true });
    expect(env.prompt.document).toEqual({ name: "Cu.cif", atoms: 4, cell: true });
    expect(env.prompt.tools?.map((t) => t.name)).toEqual([
      "liquid_box",
      "polymer_chain",
      "solvate",
    ]);
    expect(environmentFor({}).prompt).toMatchObject({ tools: null, document: null });
    expect(environmentFor({}).deps.document()).toBeNull();
  });

  it("answers a tool call with the recorded result and records what it asked", async () => {
    const env = environmentFor({ tools: true });
    const tool = env.deps.tool("liquid_box")!;
    const outcome = await env.deps.call(tool, { seed: 1 }, {} as never);
    expect(outcome.ok).toBe(true);
    expect(env.calls).toEqual([{ tool: "liquid_box", args: { seed: 1 } }]);
    expect(recordedResult("no_such_tool")).toBeNull();
    const fake = { ...tool, name: "no_such_tool" };
    expect(await env.deps.call(fake, {}, {} as never)).toEqual({
      ok: false,
      error: "No recorded result for no_such_tool.",
    });
  });
});

describe("executeFlow", () => {
  it("reports the first failed block when the output does not build", async () => {
    const c = byId("slab-pt111");
    const env = environmentFor(c.setup);
    const run = await executeFlow(
      {
        version: 1,
        nodes: [
          {
            id: "m",
            position: { x: 0, y: 0 },
            params: { type: "molecule", source: "smiles", smiles: "C1CC", libraryId: "", name: "" },
          },
          { id: "x", position: { x: 0, y: 150 }, params: { type: "supercell", repeat: [2, 2, 2] } },
        ],
        edges: [{ source: "m", target: "x", targetHandle: "structure" }],
      },
      env,
    );
    expect(run.built).toBe(false);
    expect(run.error).toMatch(/^m \(molecule\): /);
    expect(graphOf({ version: 1, nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });

  it("gives up on a run that takes too long", async () => {
    const env = environmentFor({});
    env.deps.embedSmiles = () => new Promise(() => {});
    const run = await executeFlow(
      {
        version: 1,
        nodes: [
          {
            id: "m",
            position: { x: 0, y: 0 },
            params: { type: "molecule", source: "smiles", smiles: "O", libraryId: "", name: "" },
          },
        ],
        edges: [],
      },
      env,
      50,
    );
    expect(run).toMatchObject({ built: false, error: "the run took over 0.05 s" });
  });

  it("reports a loop as an error", async () => {
    const env = environmentFor({});
    const run = await executeFlow(
      {
        version: 1,
        nodes: [
          { id: "a", position: { x: 0, y: 0 }, params: { type: "supercell", repeat: [2, 2, 2] } },
          { id: "b", position: { x: 0, y: 150 }, params: { type: "supercell", repeat: [2, 2, 2] } },
        ],
        edges: [
          { source: "a", target: "b", targetHandle: "structure" },
          { source: "b", target: "a", targetHandle: "structure" },
        ],
      },
      env,
    );
    expect(run).toMatchObject({ built: false, error: "The blocks are connected in a loop." });
  });
});

describe("Flow scorer", () => {
  const notRun: ExecuteFn = async () => {
    throw new Error("must not run");
  };

  it("scores a reply with no flow zero on every flow dimension", async () => {
    const s = await score(byId("crystal-cu-bulk"), "I would use a crystal block.", notRun);
    expect(s.total).toBe(0);
    expect(s.run).toBeNull();
    expect(s.schema.checks.every((c) => !c.passed)).toBe(true);
  });

  it("grades a flow the self-check objects to, and one with two outputs", async () => {
    const c = byId("crystal-cu-bulk");
    const stub: ExecuteFn = async (): Promise<ExecutionResult> => ({
      built: true,
      error: null,
      output: { name: "Cu", atoms: 4, elements: { Cu: 4 }, cell: true, bonds: {} },
      calls: [],
    });
    const twoOutputs = replyWith({
      version: 1,
      nodes: [
        {
          id: "a",
          position: { x: 0, y: 0 },
          params: {
            type: "crystal",
            structure: "fcc",
            elements: ["Cu", "", ""],
            a: 3.61,
            covera: 1.63,
            cubic: true,
          },
        },
        {
          id: "b",
          position: { x: 300, y: 0 },
          params: { type: "slab", miller: [0, 0, 0], layers: 4, vacuum: 10, repeat: [2, 2] },
        },
      ],
      edges: [],
    });
    const s = await score(c, twoOutputs, stub);
    const failed = s.schema.checks.filter((x) => !x.passed).map((x) => x.label);
    expect(failed).toEqual([
      "the self-check finds nothing",
      "one output block, which every block feeds",
    ]);
    expect(s.findings.length).toBeGreaterThan(0);
    expect(scoreSchema(null, null, []).score).toBe(0);
  });

  it("weights the total over the dimensions that apply", async () => {
    const prose = await score(byId("no-tools-water-box"), "Connect a tool server first.");
    expect(prose.schema.score).toBeNull();
    expect(prose.total).toBe(1);
    expect(Object.values(FLOW_DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const long = await score(
      byId("no-tools-water-box"),
      `Connect a tool server. ${"x".repeat(700)}`,
    );
    expect(long.format.score).toBe(0.5);
  });

  it("checks the reply's format", () => {
    const flow = { version: 1 as const, nodes: [], edges: [] };
    const ok = scoreFormat("```json\n{}\n```\nBuilds Cu.", flow);
    expect(ok.score).toBe(1);
    const noProse = scoreFormat("```json\n{}\n```", flow);
    expect(noProse.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([
      "has a trailing explanation",
      "explanation is a short single sentence",
    ]);
    expect(
      scoreFormat("```json\n{}\n```\n```\na\n```\n```\nb\n```\n```\nx", flow)
        .checks.filter((c) => !c.passed)
        .map((c) => c.label),
    ).toEqual([
      "no unclosed code fence",
      "at most two fenced blocks",
      "has a trailing explanation",
      "explanation is a short single sentence",
    ]);
  });

  it("fails a tool-call check when the tool was never called", () => {
    const check = called("liquid_box", "anything", () => true);
    expect(check.test({ built: true, error: null, output: null, calls: [] })).toBe(false);
    expect(moleculeArg({ smiles: "O" })).toBeNull();
  });
});

describe("selectCases", () => {
  it("runs every case when no ids are given, the empty string CI passes included", () => {
    expect(selectCases(FLOW_DATASET, undefined)).toBe(FLOW_DATASET);
    expect(selectCases(FLOW_DATASET, "")).toBe(FLOW_DATASET);
    expect(selectCases(FLOW_DATASET, " , ")).toBe(FLOW_DATASET);
  });

  it("runs the named cases, and refuses an id the dataset does not have", () => {
    expect(selectCases(FLOW_DATASET, "slab-pt111, crystal-cu-bulk").map((c) => c.id)).toEqual([
      "crystal-cu-bulk",
      "slab-pt111",
    ]);
    expect(() => selectCases(FLOW_DATASET, "slab-pt111,slab-typo")).toThrow(
      "Unknown case id(s): slab-typo",
    );
  });
});

describe("Flow runner and report", () => {
  const cases = [byId("crystal-cu-bulk"), byId("no-tools-water-box")];

  it("runs every case, records a failed generation, and reports", async () => {
    const done: string[] = [];
    const records = await runFlowDataset(
      cases,
      async (c) => {
        if (c.id === "no-tools-water-box") throw new Error("rate limited");
        return GOLDEN[c.id].reference();
      },
      executeFlow,
      { onResult: (r, i, total) => done.push(`${i + 1}/${total} ${r.case.id}`) },
    );
    expect(done).toEqual(["1/2 crystal-cu-bulk", "2/2 no-tools-water-box"]);
    expect(records[0].score.total).toBe(1);
    expect(records[1]).toMatchObject({ error: "rate limited", response: "" });

    const agg = aggregateFlow(records);
    expect(agg).toMatchObject({ count: 2, passRate: 0.5, buildRate: 1 });
    expect(agg.byTag.crystal).toEqual({ count: 1, meanTotal: 1 });
    const meta = { bench: "flow" as const, provider: "stub", model: "m", timestamp: "t" };
    const json = flowToJSON(meta, records, agg);
    expect(json.cases[0]).toMatchObject({
      id: "crystal-cu-bulk",
      total: 1,
      failedChecks: [],
      built: { atoms: 4, elements: { Cu: 4 }, cell: true },
    });
    expect(json.cases[1].failedChecks).toContain("task: says a tool server is needed");
    const md = flowToMarkdown(meta, records, agg);
    expect(md).toContain("| crystal-cu-bulk | 100% |");
    expect(md).toContain("4 atoms (Cu4)");
    expect(md).toContain("error: rate limited");
    expect(aggregateFlow([])).toMatchObject({ count: 0, meanTotal: 0, passRate: 0, buildRate: 0 });
  });

  it("shows why a flow did not build", async () => {
    const c = byId("slab-pt111");
    const records = await runFlowDataset(
      [c],
      async () => GOLDEN["crystal-cu-bulk"].reference(),
      async () => ({ built: false, error: "n1 (crystal): boom", output: null, calls: [] }),
    );
    const md = flowToMarkdown(
      { bench: "flow", provider: "p", model: "m", timestamp: "t" },
      records,
      aggregateFlow(records),
    );
    expect(md).toContain("failed: n1 (crystal): boom");
  });
});

describe("live generation", () => {
  it("wraps an edit request in the flow it edits", () => {
    expect(flowRequest(byId("crystal-cu-bulk"))).toBe("Build bulk fcc copper.");
    const edit = flowRequest(byId("edit-slab-layers"));
    expect(edit).toContain("## Current flow");
    expect(edit).toContain("Selected in the graph: `n2` (slab).");
    expect(edit.endsWith("## Request\n\nMake this slab 6 layers thick.")).toBe(true);
  });

  it("sends the Flow prompt and repairs what the self-check finds", async () => {
    const c = byId("crystal-cu-bulk");
    const env = environmentFor(c.setup);
    const replies = [
      replyWith({
        version: 1,
        nodes: [{ id: "n1", position: { x: 0, y: 0 }, params: { type: "slab" } as never }],
        edges: [],
      }),
      GOLDEN[c.id].reference(),
    ];
    const bodies: { system: string; messages: { role: string; content: unknown }[] }[] = [];
    const fetchStub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      const text = replies[bodies.length - 1];
      return new Response(
        JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
      );
    }) as unknown as typeof fetch;
    const stats = { repairRounds: 0 };
    const text = await generateFlowLive(
      { provider: "anthropic", model: "m", apiKey: "k" },
      c,
      env,
      fetchStub,
      stats,
    );
    expect(text).toBe(replies[1]);
    expect(stats.repairRounds).toBe(1);
    expect(bodies[0].system).toContain("Megane Builder's Flow mode");
    expect(String(bodies[1].messages[2].content)).toContain('needs a wire into its "bulk" input');
  });
});
