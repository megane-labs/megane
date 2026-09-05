import { describe, it, expect } from "vitest";

import {
  extractPipeline,
  extractTrailingExplanation,
  findLastValidPipeline,
} from "../../../bench/llm/extract";
import {
  scoreSchema,
  scoreTask,
  scoreParams,
  scoreFormat,
  scoreResponse,
  type Rubric,
} from "../../../bench/llm/scorer";
import {
  loadSkills,
  buildToolDefinitions,
  buildOpenAITools,
  executeSkill,
  parseFrontmatter,
  toSnakeCase,
} from "../../../bench/llm/skills";
import {
  configFromEnv,
  assertConfig,
  generatePipelineLive,
  DEFAULT_PLAMO_MODEL,
  PLAMO_API_URL,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_API_URL,
} from "../../../bench/llm/providers";
import { runDataset } from "../../../bench/llm/runner";
import { aggregate, toMarkdown, toJSON } from "../../../bench/llm/report";
import { DATASET } from "../../../bench/llm/dataset";
import { NODE_PORTS, type SerializedPipeline } from "@/pipeline/types";

// ─── Fixtures ─────────────────────────────────────────────────────────

const PERFECT_MOLECULE: SerializedPipeline = {
  version: 3,
  nodes: [
    {
      id: "loader-1",
      type: "load_structure",
      position: { x: 0, y: 0 },
      fileName: null,
      hasTrajectory: false,
      hasCell: true,
    },
    { id: "addbond-1", type: "add_bond", position: { x: 0, y: 300 }, bondSource: "structure" },
    {
      id: "viewport-1",
      type: "viewport",
      position: { x: 0, y: 600 },
      perspective: false,
      cellAxesVisible: true,
      pivotMarkerVisible: true,
    },
  ],
  edges: [
    { source: "loader-1", target: "addbond-1", sourceHandle: "particle", targetHandle: "particle" },
    {
      source: "loader-1",
      target: "viewport-1",
      sourceHandle: "particle",
      targetHandle: "particle",
    },
    { source: "addbond-1", target: "viewport-1", sourceHandle: "bond", targetHandle: "bond" },
  ],
};

function fenced(
  p: SerializedPipeline,
  explanation = "Loads the structure and shows bonds.",
): string {
  return "```json\n" + JSON.stringify(p) + "\n```\n\n" + explanation;
}

// ─── extract ──────────────────────────────────────────────────────────

describe("extract", () => {
  it("recovers a pipeline from a fenced block", () => {
    const r = extractPipeline(fenced(PERFECT_MOLECULE));
    expect(r.source).toBe("fenced");
    expect(r.pipeline?.nodes).toHaveLength(3);
    expect(r.fenceCount).toBe(1);
    expect(r.hasUnclosedFence).toBe(false);
  });

  it("prefers the last valid fence over an earlier one", () => {
    const small: SerializedPipeline = {
      version: 3,
      nodes: [
        {
          id: "v",
          type: "viewport",
          position: { x: 0, y: 0 },
          perspective: false,
          cellAxesVisible: true,
          pivotMarkerVisible: true,
        },
      ],
      edges: [],
    };
    const text = fenced(small, "first") + "\n" + fenced(PERFECT_MOLECULE, "second");
    expect(findLastValidPipeline(text)?.nodes).toHaveLength(3);
  });

  it("falls back to bare JSON when no fence is present", () => {
    const r = extractPipeline("here: " + JSON.stringify(PERFECT_MOLECULE) + " done");
    expect(r.source).toBe("bare");
    expect(r.pipeline?.nodes).toHaveLength(3);
  });

  it("reports an unclosed fence and recovers nothing", () => {
    const r = extractPipeline('```json\n{ "version": 3, "nodes": [');
    expect(r.hasUnclosedFence).toBe(true);
    expect(r.pipeline).toBeNull();
    expect(r.source).toBe("none");
  });

  it("extractTrailingExplanation returns prose after the closed fence", () => {
    expect(extractTrailingExplanation(fenced(PERFECT_MOLECULE, "Shows bonds."))).toBe(
      "Shows bonds.",
    );
    expect(extractTrailingExplanation("```json\n{")).toBe("");
  });
});

// ─── schema dimension ─────────────────────────────────────────────────

describe("scoreSchema", () => {
  it("gives a perfect pipeline a full score", () => {
    const r = scoreSchema(PERFECT_MOLECULE);
    expect(r.score).toBe(1);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it("scores a null pipeline as zero", () => {
    expect(scoreSchema(null).score).toBe(0);
  });

  it("penalizes a missing viewport", () => {
    const p: SerializedPipeline = {
      ...PERFECT_MOLECULE,
      nodes: PERFECT_MOLECULE.nodes.slice(0, 2),
      edges: [PERFECT_MOLECULE.edges[0]],
    };
    const r = scoreSchema(p);
    expect(r.score).toBeLessThan(1);
    expect(r.checks.find((c) => c.label === "exactly one viewport node")?.passed).toBe(false);
  });

  it("penalizes a type-incompatible edge", () => {
    const p: SerializedPipeline = {
      ...PERFECT_MOLECULE,
      edges: [
        ...PERFECT_MOLECULE.edges,
        {
          source: "loader-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "bond",
        },
      ],
    };
    const r = scoreSchema(p);
    expect(r.checks.find((c) => c.label === "edges connect type-compatible ports")?.passed).toBe(
      false,
    );
  });

  it("detects a cycle", () => {
    const p: SerializedPipeline = {
      ...PERFECT_MOLECULE,
      edges: [
        ...PERFECT_MOLECULE.edges,
        { source: "viewport-1", target: "addbond-1", sourceHandle: "x", targetHandle: "particle" },
      ],
    };
    expect(scoreSchema(p).checks.find((c) => c.label === "graph is acyclic")?.passed).toBe(false);
  });

  it("flags a disconnected node", () => {
    const p: SerializedPipeline = {
      ...PERFECT_MOLECULE,
      nodes: [
        ...PERFECT_MOLECULE.nodes,
        {
          id: "orphan",
          type: "load_structure",
          position: { x: 500, y: 0 },
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
        },
      ],
    };
    expect(
      scoreSchema(p).checks.find((c) => c.label === "all nodes reach a viewport")?.passed,
    ).toBe(false);
  });
});

// ─── task dimension ───────────────────────────────────────────────────

describe("scoreTask", () => {
  it("returns null when the rubric has no task constraints", () => {
    expect(scoreTask(PERFECT_MOLECULE, {}).score).toBeNull();
  });

  it("rewards required node types and connections", () => {
    const rubric: Rubric = {
      requiredNodeTypes: ["load_structure", "add_bond", "viewport"],
      requiredConnections: [
        {
          sourceType: "add_bond",
          targetType: "viewport",
          sourceHandle: "bond",
          targetHandle: "bond",
        },
      ],
      minNodes: 3,
    };
    expect(scoreTask(PERFECT_MOLECULE, rubric).score).toBe(1);
  });

  it("penalizes a forbidden node type", () => {
    const r = scoreTask(PERFECT_MOLECULE, { forbiddenNodeTypes: ["add_bond"] });
    expect(r.score).toBe(0);
  });

  it("penalizes a missing connection", () => {
    const r = scoreTask(PERFECT_MOLECULE, {
      requiredConnections: [{ sourceType: "label_generator", targetType: "viewport" }],
    });
    expect(r.score).toBe(0);
  });
});

// ─── params dimension ─────────────────────────────────────────────────

describe("scoreParams", () => {
  it("returns null when there are no param checks", () => {
    expect(scoreParams(PERFECT_MOLECULE, {}).score).toBeNull();
  });

  it("scores a matching parameter as full", () => {
    const r = scoreParams(PERFECT_MOLECULE, {
      paramChecks: [
        {
          label: "structure bonds",
          nodeType: "add_bond",
          test: (n) => (n as { bondSource?: string }).bondSource === "structure",
        },
      ],
    });
    expect(r.score).toBe(1);
  });

  it("fails when the target node is absent", () => {
    const r = scoreParams(PERFECT_MOLECULE, {
      paramChecks: [{ label: "filter q", nodeType: "filter", test: () => true }],
    });
    expect(r.score).toBe(0);
  });

  it("treats a throwing predicate as a failure", () => {
    const r = scoreParams(PERFECT_MOLECULE, {
      paramChecks: [
        {
          label: "boom",
          nodeType: "add_bond",
          test: () => {
            throw new Error("x");
          },
        },
      ],
    });
    expect(r.score).toBe(0);
  });
});

// ─── format dimension ─────────────────────────────────────────────────

describe("scoreFormat", () => {
  it("rewards fenced JSON with a trailing one-sentence explanation", () => {
    const text = fenced(PERFECT_MOLECULE);
    const r = scoreFormat(text, extractPipeline(text));
    expect(r.score).toBe(1);
  });

  it("penalizes bare JSON output", () => {
    const text = JSON.stringify(PERFECT_MOLECULE);
    const r = scoreFormat(text, extractPipeline(text));
    expect(r.score).toBeLessThan(1);
    expect(r.checks.find((c) => c.label === "pipeline recovered from a fenced block")?.passed).toBe(
      false,
    );
  });

  it("penalizes a bullet-list explanation", () => {
    const text =
      "```json\n" + JSON.stringify(PERFECT_MOLECULE) + "\n```\n- does a thing\n- does another";
    const r = scoreFormat(text, extractPipeline(text));
    expect(r.checks.find((c) => c.label === "explanation is a short single sentence")?.passed).toBe(
      false,
    );
  });
});

// ─── aggregate scoreResponse ──────────────────────────────────────────

describe("scoreResponse", () => {
  it("gives a perfect fenced molecule near 1.0", () => {
    const rubric: Rubric = {
      requiredNodeTypes: ["load_structure", "add_bond", "viewport"],
      paramChecks: [
        {
          label: "structure",
          nodeType: "add_bond",
          test: (n) => (n as { bondSource?: string }).bondSource === "structure",
        },
      ],
    };
    const s = scoreResponse(fenced(PERFECT_MOLECULE), rubric);
    expect(s.total).toBe(1);
  });

  it("renormalizes the total over applicable dimensions only", () => {
    // No task/params constraints -> total is the weighted mean of schema+format only.
    const s = scoreResponse(fenced(PERFECT_MOLECULE), {});
    expect(s.task.score).toBeNull();
    expect(s.params.score).toBeNull();
    expect(s.total).toBe(1);
  });

  it("scores an unparseable response as zero", () => {
    const s = scoreResponse("Sorry, I cannot help with that.", { requiredNodeTypes: ["viewport"] });
    expect(s.total).toBe(0);
    expect(s.pipeline).toBeNull();
  });
});

// ─── skills ───────────────────────────────────────────────────────────

describe("skills", () => {
  it("loads the production skill markdown from disk", () => {
    const skills = loadSkills();
    const names = skills.map((s) => s.name).sort();
    expect(names).toContain("get-molecule-template");
    expect(names).toContain("get-solid-template");
    expect(skills.every((s) => s.content.length > 0)).toBe(true);
  });

  it("builds tool definitions with snake_case names", () => {
    const skills = loadSkills();
    const anthropic = buildToolDefinitions(skills);
    const openai = buildOpenAITools(skills);
    expect(anthropic.some((t) => t.name === "get_molecule_template")).toBe(true);
    expect(openai.some((t) => t.function.name === "get_solid_template")).toBe(true);
  });

  it("executes a skill by tool name", () => {
    const skills = loadSkills();
    expect(executeSkill(skills, "get_molecule_template")).toContain("Molecule Pipeline Template");
    expect(executeSkill(skills, "unknown")).toBeNull();
  });

  it("parseFrontmatter and toSnakeCase behave as expected", () => {
    const { attrs, content } = parseFrontmatter("---\nname: a-b\ndescription: d\n---\nbody");
    expect(attrs.name).toBe("a-b");
    expect(content).toBe("body");
    expect(toSnakeCase("a-b-c")).toBe("a_b_c");
  });
});

// ─── dataset integrity ────────────────────────────────────────────────

describe("dataset", () => {
  it("has unique ids and non-empty prompts/tags", () => {
    const ids = DATASET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DATASET.every((c) => c.prompt.length > 0 && c.tags.length > 0)).toBe(true);
  });

  it("references only known node types in every rubric", () => {
    const known = new Set(Object.keys(NODE_PORTS));
    for (const c of DATASET) {
      const r = c.rubric;
      for (const t of [...(r.requiredNodeTypes ?? []), ...(r.forbiddenNodeTypes ?? [])]) {
        expect(known.has(t)).toBe(true);
      }
      for (const conn of r.requiredConnections ?? []) {
        expect(known.has(conn.sourceType)).toBe(true);
        // `targetType` accepts a list so a rubric can require that a selection
        // is *used* without dictating which visual node uses it.
        for (const t of Array.isArray(conn.targetType) ? conn.targetType : [conn.targetType]) {
          expect(known.has(t)).toBe(true);
        }
      }
      for (const pc of r.paramChecks ?? []) {
        expect(known.has(pc.nodeType)).toBe(true);
      }
    }
  });
});

// ─── runner + report ──────────────────────────────────────────────────

describe("runner + report", () => {
  it("runs the dataset through a stub generate and aggregates", async () => {
    const cases = DATASET.slice(0, 3);
    const records = await runDataset(cases, async (prompt) => {
      // Echo a perfect molecule for every prompt regardless of content.
      void prompt;
      return fenced(PERFECT_MOLECULE);
    });
    expect(records).toHaveLength(3);
    const agg = aggregate(records);
    expect(agg.count).toBe(3);
    expect(agg.meanTotal).toBeGreaterThan(0);
    expect(agg.byDimension.schema).toBe(1);
    const md = toMarkdown({ provider: "stub", model: "stub", timestamp: "t" }, records, agg);
    expect(md).toContain("megane LLM benchmark");
    const json = toJSON({ provider: "stub", model: "stub", timestamp: "t" }, records, agg);
    expect(json.cases).toHaveLength(3);
  });

  it("captures a generation error without aborting the run", async () => {
    const records = await runDataset(DATASET.slice(0, 2), async () => {
      throw new Error("network down");
    });
    expect(records).toHaveLength(2);
    expect(records[0].error).toBe("network down");
    expect(records[0].score.total).toBe(0);
  });
});

// ─── providers ────────────────────────────────────────────────────────

describe("providers", () => {
  describe("configFromEnv", () => {
    it("defaults to anthropic when MEGANE_LLM_PROVIDER is unset", () => {
      const config = configFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" });
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-20250514");
      expect(config.apiKey).toBe("sk-ant-x");
    });

    it("reads the OpenAI key for provider=openai", () => {
      const config = configFromEnv({ MEGANE_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" });
      expect(config).toEqual({ provider: "openai", model: "gpt-4o", apiKey: "sk-x" });
    });

    it("reads PLAMO_API_KEY and defaults to the PLaMo flagship model", () => {
      const config = configFromEnv({ MEGANE_LLM_PROVIDER: "plamo", PLAMO_API_KEY: "plamo-x" });
      expect(config).toEqual({
        provider: "plamo",
        model: DEFAULT_PLAMO_MODEL,
        apiKey: "plamo-x",
      });
    });

    it("lets MEGANE_LLM_MODEL override the PLaMo model", () => {
      const config = configFromEnv({
        MEGANE_LLM_PROVIDER: "plamo",
        MEGANE_LLM_MODEL: "plamo-2.2-prime",
        PLAMO_API_KEY: "plamo-x",
      });
      expect(config.model).toBe("plamo-2.2-prime");
    });

    it("reads OPENROUTER_API_KEY and defaults to the OpenRouter bench model", () => {
      const config = configFromEnv({
        MEGANE_LLM_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-x",
      });
      expect(config).toEqual({
        provider: "openrouter",
        model: DEFAULT_OPENROUTER_MODEL,
        apiKey: "sk-or-x",
      });
    });

    it("lets MEGANE_LLM_MODEL override the OpenRouter model", () => {
      const config = configFromEnv({
        MEGANE_LLM_PROVIDER: "openrouter",
        MEGANE_LLM_MODEL: "anthropic/claude-sonnet-4.6",
        OPENROUTER_API_KEY: "sk-or-x",
      });
      expect(config.model).toBe("anthropic/claude-sonnet-4.6");
    });

    it("resolves the demo proxy from MEGANE_LLM_PROXY_URL", () => {
      const config = configFromEnv({
        MEGANE_LLM_PROVIDER: "demo",
        MEGANE_LLM_PROXY_URL: "https://proxy.example.com/chat",
      });
      expect(config).toEqual({
        provider: "demo",
        model: "demo",
        proxyUrl: "https://proxy.example.com/chat",
      });
    });
  });

  describe("assertConfig", () => {
    it("throws a named error when the PLaMo key is missing", () => {
      expect(() => assertConfig({ provider: "plamo", model: DEFAULT_PLAMO_MODEL })).toThrow(
        "PLAMO_API_KEY is not set",
      );
    });

    it("accepts a complete PLaMo config", () => {
      expect(() =>
        assertConfig({ provider: "plamo", model: DEFAULT_PLAMO_MODEL, apiKey: "plamo-x" }),
      ).not.toThrow();
    });

    it("throws a named error when the OpenRouter key is missing", () => {
      expect(() =>
        assertConfig({ provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL }),
      ).toThrow("OPENROUTER_API_KEY is not set");
    });

    it("accepts a complete OpenRouter config", () => {
      expect(() =>
        assertConfig({
          provider: "openrouter",
          model: DEFAULT_OPENROUTER_MODEL,
          apiKey: "sk-or-x",
        }),
      ).not.toThrow();
    });

    it("throws for every other provider missing its credential", () => {
      expect(() => assertConfig({ provider: "anthropic", model: "m" })).toThrow(
        "ANTHROPIC_API_KEY is not set",
      );
      expect(() => assertConfig({ provider: "openai", model: "m" })).toThrow(
        "OPENAI_API_KEY is not set",
      );
      expect(() => assertConfig({ provider: "demo", model: "demo" })).toThrow(
        "MEGANE_LLM_PROXY_URL is not set",
      );
    });
  });

  describe("generatePipelineLive (OpenAI-compatible providers)", () => {
    /** Minimal OpenAI-shaped non-streaming completion. */
    function completion(content: string, finishReason = "stop") {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    it("posts to the PLaMo endpoint with bearer auth and the configured model", async () => {
      const calls: Array<{
        url: string;
        body: Record<string, unknown>;
        headers: Record<string, string>;
      }> = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse(init.body as string),
          headers: init.headers as Record<string, string>,
        });
        return completion("done");
      }) as unknown as typeof fetch;

      const text = await generatePipelineLive(
        { provider: "plamo", model: "plamo-3.0-prime", apiKey: "plamo-x" },
        "show bonds",
        fetchImpl,
      );

      expect(text).toBe("done");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(PLAMO_API_URL);
      expect(calls[0].headers.Authorization).toBe("Bearer plamo-x");
      expect(calls[0].body.model).toBe("plamo-3.0-prime");
      const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe("system");
      expect(messages[1]).toEqual({ role: "user", content: "show bonds" });
      // Skills are offered as OpenAI function definitions, as in production.
      expect(Array.isArray(calls[0].body.tools)).toBe(true);
    });

    it("answers a tool_calls round trip with the skill body and returns the follow-up text", async () => {
      const skillName = buildOpenAITools(loadSkills())[0].function.name;
      let round = 0;
      const sent: Array<Array<Record<string, unknown>>> = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        sent.push(body.messages);
        round += 1;
        if (round === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: skillName, arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return completion("```json\n{}\n```");
      }) as unknown as typeof fetch;

      const text = await generatePipelineLive(
        { provider: "plamo", model: DEFAULT_PLAMO_MODEL, apiKey: "plamo-x" },
        "show bonds",
        fetchImpl,
      );

      expect(round).toBe(2);
      expect(text).toContain("```json");
      const second = sent[1];
      expect(second[second.length - 2]).toMatchObject({ role: "assistant" });
      expect(second[second.length - 1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
      expect(second[second.length - 1].content).toBe(executeSkill(loadSkills(), skillName));
    });

    it("throws with the provider name and status when PLaMo rejects the request", async () => {
      const fetchImpl = (async () =>
        new Response("unknown model", { status: 400 })) as unknown as typeof fetch;

      await expect(
        generatePipelineLive(
          { provider: "plamo", model: "plamo-9.9-prime", apiKey: "plamo-x" },
          "show bonds",
          fetchImpl,
        ),
      ).rejects.toThrow(/plamo request failed \(400\): unknown model/);
    });

    it("posts to the OpenRouter endpoint with bearer auth for provider=openrouter", async () => {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return completion("done");
      }) as unknown as typeof fetch;

      const text = await generatePipelineLive(
        { provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL, apiKey: "sk-or-x" },
        "show bonds",
        fetchImpl,
      );

      expect(text).toBe("done");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(OPENROUTER_API_URL);
      expect(calls[0].headers.Authorization).toBe("Bearer sk-or-x");
    });
  });
});
