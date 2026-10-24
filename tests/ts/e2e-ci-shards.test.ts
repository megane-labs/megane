/**
 * Guards the webapp-host split in `.github/workflows/e2e.yml`: CI runs those
 * projects on one runner per `test:e2e:ci:webapp:<n>` script, while
 * `test:e2e:ci:webapp` stays the full list that the "E2E update baselines"
 * workflow records and local runs use. A project in one list but not the
 * other would silently drop out of the CI check or out of the CI baselines.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const scripts: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).scripts;
const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "e2e.yml"), "utf8");

const SHARD_SCRIPT = /^test:e2e:ci:webapp:(\d+)$/;
const shardScripts = Object.keys(scripts).filter((name) => SHARD_SCRIPT.test(name));

/** The `--project=<name>` values of a `playwright test` script. */
export function projectsOf(script: string): string[] {
  return [...script.matchAll(/--project=(\S+)/g)].map((m) => m[1]);
}

describe("E2E CI webapp shards", () => {
  it("each shard script only selects projects", () => {
    expect(shardScripts.length).toBeGreaterThan(1);
    for (const name of shardScripts) {
      expect(scripts[name], name).toMatch(/^playwright test( --project=\S+)+$/);
    }
  });

  it("together run every project of test:e2e:ci:webapp exactly once", () => {
    const all = projectsOf(scripts["test:e2e:ci:webapp"]).sort();
    const sharded = shardScripts.flatMap((name) => projectsOf(scripts[name])).sort();
    expect(sharded).toEqual(all);
  });

  it("match the shard matrix in e2e.yml", () => {
    const matrix = /^\s*shard: \[([\d, ]+)\]$/m.exec(workflow);
    expect(matrix, "e2e.yml has no `shard: [...]` matrix").not.toBeNull();
    const shards = matrix![1].split(",").map((s) => Number(s.trim()));
    const numbers = shardScripts.map((name) => Number(SHARD_SCRIPT.exec(name)![1]));
    expect(shards).toEqual(numbers.sort((a, b) => a - b));
    expect(workflow).toContain("npm run test:e2e:ci:webapp:${{ matrix.shard }}");
  });
});

describe("projectsOf", () => {
  it("reads every --project value in order", () => {
    expect(projectsOf("playwright test --project=a --project=b__webapp")).toEqual([
      "a",
      "b__webapp",
    ]);
    expect(projectsOf("playwright test")).toEqual([]);
  });
});
