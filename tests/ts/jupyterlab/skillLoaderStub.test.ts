import { describe, it, expect } from "vitest";

import * as realSkillLoader from "../../../src/ai/skillLoader";
import {
  buildOpenAITools,
  buildToolDefinitions,
  executeSkill,
  getSkills,
  loadSkills,
  parseFrontmatter,
  type PipelineSkill,
} from "../../../jupyterlab-megane/src/skillLoaderStub";
import * as stub from "../../../jupyterlab-megane/src/skillLoaderStub";

describe("jupyterlab skillLoaderStub", () => {
  it("exports every runtime binding the real skillLoader does", () => {
    // webpack swaps this stub in for src/ai/skillLoader.ts in the labextension
    // bundle, so any export missing here becomes an `undefined is not a
    // function` crash in JupyterLab (src/ai/client.ts imports them eagerly).
    const realExports = Object.keys(realSkillLoader).sort();
    const stubExports = Object.keys(stub).sort();
    expect(stubExports).toEqual(realExports);
  });

  it("loadSkills returns an empty array (and a fresh reference each call)", () => {
    const first = loadSkills();
    const second = loadSkills();
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(first).not.toBe(second);
  });

  it("getSkills returns an empty array", () => {
    expect(getSkills()).toEqual([]);
  });

  it("buildToolDefinitions returns an empty array regardless of input", () => {
    expect(buildToolDefinitions([])).toEqual([]);
    const skills: PipelineSkill[] = [
      { name: "foo", description: "d1", content: "c1" },
      { name: "bar", description: "d2", content: "c2" },
    ];
    expect(buildToolDefinitions(skills)).toEqual([]);
  });

  it("buildOpenAITools returns an empty array regardless of input", () => {
    expect(buildOpenAITools([])).toEqual([]);
    const skills: PipelineSkill[] = [
      { name: "foo", description: "d1", content: "c1" },
      { name: "bar", description: "d2", content: "c2" },
    ];
    expect(buildOpenAITools(skills)).toEqual([]);
  });

  it("parseFrontmatter returns the raw text with no attributes", () => {
    const raw = "---\nname: foo\n---\nbody";
    expect(parseFrontmatter(raw)).toEqual({ attrs: {}, content: raw });
  });

  it("executeSkill returns null on an empty skill set", () => {
    expect(executeSkill([], "anything")).toBeNull();
  });

  it("executeSkill ignores its arguments and still returns null", () => {
    const skills: PipelineSkill[] = [{ name: "skill-name", description: "d", content: "c" }];
    expect(executeSkill(skills, "skill-name")).toBeNull();
  });
});
