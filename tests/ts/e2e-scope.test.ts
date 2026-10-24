import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/e2e-scope.mjs decides which E2E jobs .github/workflows/e2e.yml runs
// for a change. It is build tooling outside the instrumented coverage scope,
// but a wrong answer silently skips E2E a change needed, so its rules are
// pinned here path by path.
import { e2eScope, outputLines } from "../../scripts/e2e-scope.mjs";

const SCRIPT = join(__dirname, "..", "..", "scripts", "e2e-scope.mjs");

/** The two booleans the workflow reads. */
function hosts(paths: string[]) {
  const scope = e2eScope(paths);
  return { webapp: scope.webapp !== null, jupyterlab: scope.jupyterlab !== null };
}

const NONE = { webapp: false, jupyterlab: false };
const BOTH = { webapp: true, jupyterlab: true };
const LAB = { webapp: false, jupyterlab: true };

describe("e2eScope", () => {
  it.each([
    "README.md",
    "CHANGELOG.md",
    "AGENTS.md",
    "LICENSE",
    ".agents/skills/testing/SKILL.md",
    ".claude/settings.json",
    ".codex/config.toml",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/actions/codecov-upload/action.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/e2e-update-baselines.yml",
    "docs/docs/guide/builder.md",
    "docs/package-lock.json",
    "paper/paper.md",
    "deploy/terraform/main.tf",
    "workers/llm-proxy/package-lock.json",
    "vscode-megane/package-lock.json",
    "vscode-megane/src/extension.ts",
    "bench/llm/dataset.ts",
    "examples/quickstart.ipynb",
    "tests/ts/e2e-scope.test.ts",
    "tests/python/test_cli.py",
    "tests/notebooks/test_pipeline.ipynb",
    "codecov.yml",
    "vitest.config.ts",
    "eslint.config.js",
    "Dockerfile",
    "Makefile",
    "vite.lib.config.ts",
  ])("%s reaches neither host", (path) => {
    expect(hosts([path])).toEqual(NONE);
  });

  it.each([
    "python/megane/server.py",
    "crates/megane-python/src/lib.rs",
    "jupyterlab-megane/src/index.ts",
    "jupyterlab-megane/package-lock.json",
    "pyproject.toml",
    "uv.lock",
    "vite.widget.config.ts",
    "vite.builder-widget.config.ts",
    "wheel-share/data/etc/jupyter/jupyter_server_config.d/megane.json",
  ])("%s reaches only the JupyterLab hosts", (path) => {
    expect(hosts([path])).toEqual(LAB);
  });

  it.each([
    "src/renderer/MoleculeRenderer.ts",
    // Markdown below the root ships in the app (the AI assistant's skills).
    "src/ai/skills/molecule-template.md",
    "crates/megane-core/src/pdb.rs",
    "crates/megane-wasm/src/lib.rs",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "vite.shared.ts",
    "index.html",
    "playwright.config.ts",
    "tests/e2e/webapp.spec.ts",
    "tests/e2e/baselines-ci/webapp/default.png",
    "tests/fixtures/1crn.pdb",
    "scripts/build-wasm.mjs",
    "scripts/e2e-scope.mjs",
    ".github/workflows/e2e.yml",
    ".github/actions/e2e-setup/action.yml",
    // A directory nobody has classified yet runs everything.
    "new-top-level-dir/file.ts",
  ])("%s reaches both hosts", (path) => {
    expect(hosts([path])).toEqual(BOTH);
  });

  it("reports the first path that reaches each host", () => {
    expect(e2eScope(["docs/a.md", "uv.lock", "python/x.py", "src/a.ts", "src/b.ts"])).toEqual({
      webapp: "src/a.ts",
      jupyterlab: "uv.lock",
    });
  });

  it("skips everything for an empty change", () => {
    expect(hosts([])).toEqual(NONE);
  });
});

describe("outputLines", () => {
  it("writes one key=value line per host", () => {
    expect(outputLines({ webapp: "src/a.ts", jupyterlab: null })).toBe(
      "webapp=true\njupyterlab=false\n",
    );
  });
});

describe("e2e-scope CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function run(stdin: string, env: Record<string, string> = {}) {
    const { GITHUB_OUTPUT: _ignored, ...rest } = process.env;
    return spawnSync(process.execPath, [SCRIPT], {
      input: stdin,
      encoding: "utf8",
      env: { ...rest, ...env },
    });
  }

  it("appends the outputs to $GITHUB_OUTPUT and explains each decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-scope-"));
    dirs.push(dir);
    const out = join(dir, "output");
    const res = run("docs/a.md\n\nuv.lock\n", { GITHUB_OUTPUT: out });
    expect(res.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("webapp=false\njupyterlab=true\n");
    expect(res.stdout).toContain("webapp: skip — none of the 2 changed paths can reach it");
    expect(res.stdout).toContain("jupyterlab: run — uv.lock can reach it");
  });

  it("prints the outputs when $GITHUB_OUTPUT is unset", () => {
    const res = run("src/a.ts\n");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("webapp=true\njupyterlab=true\n");
  });
});
