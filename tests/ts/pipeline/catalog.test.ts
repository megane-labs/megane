import { describe, it, expect } from "vitest";
import { NODE_CATALOG, PROMPT_NODE_ORDER } from "@/pipeline/catalog";
import { NODE_PORTS, defaultParams } from "@/pipeline/types";
import type { PipelineNodeType } from "@/pipeline/types";

const ALL_TYPES = Object.keys(NODE_PORTS) as PipelineNodeType[];

// Ephemeral / view-only keys that never appear in the serialized documentation.
const NON_DOC_KEYS = new Set(["type"]);

describe("NODE_CATALOG", () => {
  it("has an entry for every node type", () => {
    for (const type of ALL_TYPES) {
      expect(NODE_CATALOG[type], `missing catalog entry for ${type}`).toBeDefined();
    }
  });

  it("documents every default parameter of each node type", () => {
    for (const type of ALL_TYPES) {
      const defaultKeys = Object.keys(defaultParams(type)).filter((k) => !NON_DOC_KEYS.has(k));
      const documented = new Set(NODE_CATALOG[type].params.map((p) => p.jsonKey));
      for (const key of defaultKeys) {
        expect(documented.has(key), `${type}.${key} is not documented in the catalog`).toBe(true);
      }
    }
  });

  it("gives every node a non-empty description", () => {
    for (const type of ALL_TYPES) {
      expect(NODE_CATALOG[type].description.length).toBeGreaterThan(0);
    }
  });

  it("marks only streaming as excluded from the prompt", () => {
    for (const type of ALL_TYPES) {
      expect(NODE_CATALOG[type].inPrompt).toBe(type !== "streaming");
    }
  });

  it("gives every node a Python class", () => {
    // tests/python/test_pipeline_node_drift.py checks each name is a real
    // `megane` export whose _node_type matches.
    for (const type of ALL_TYPES) {
      expect(NODE_CATALOG[type].pythonClass, `${type} has no Python class`).toBeTruthy();
    }
  });

  it("does not use special-case fenced parameter rendering", () => {
    for (const type of ALL_TYPES) {
      expect(NODE_CATALOG[type].promptParamsFenced).toBeUndefined();
    }
  });
});

describe("PROMPT_NODE_ORDER", () => {
  it("lists exactly the prompt-visible nodes, streaming excluded", () => {
    expect(PROMPT_NODE_ORDER).toHaveLength(ALL_TYPES.length - 1);
    expect(PROMPT_NODE_ORDER).not.toContain("streaming");
    expect(PROMPT_NODE_ORDER).toContain("viewport");
  });

  it("starts with load_structure (the primary data source)", () => {
    expect(PROMPT_NODE_ORDER[0]).toBe("load_structure");
  });
});
