/**
 * e2e-scope — decides which E2E jobs in .github/workflows/e2e.yml a change can
 * affect, so the workflow skips the ones it cannot.
 *
 * Usage: git diff --name-only --no-renames <base> <head> | node scripts/e2e-scope.mjs
 *
 * Reads changed paths (one per line) on stdin and writes `webapp=true|false`
 * and `jupyterlab=true|false` to $GITHUB_OUTPUT (stdout when it is unset).
 *
 * Every path counts for both host groups unless it matches one of the lists
 * below, so a new directory runs the whole suite until someone lists it here:
 *   - NO_E2E: reaches neither the webapp nor the JupyterLab hosts (prose,
 *     agent tooling, other workflows, unit-test trees, the VS Code extension —
 *     whose hosts are local-only — the LLM proxy worker, the docs site).
 *   - JUPYTERLAB_ONLY: reaches only the JupyterLab hosts (the Python package,
 *     its PyO3 crate, the labextension, the widget bundles).
 */

import { appendFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

export const NO_E2E = [
  /^[^/]+\.md$/, // README, CHANGELOG, AGENTS.md, ... at the root only: src/ai/skills/*.md ship in the app
  /^LICENSE$/,
  /^\.(agents|claude|codex)\//,
  /^\.github\/(ISSUE_TEMPLATE|codeql)\//,
  /^\.github\/pull_request_template\.md$/,
  /^\.github\/actions\/(?!e2e-setup\/)/,
  /^\.github\/workflows\/(?!e2e\.yml$)/,
  /^(bench|deploy|docs|examples|paper|vscode-megane|workers)\//,
  /^tests\/(notebooks|python|ts)\//,
  /^(\.dockerignore|\.prettierignore|\.prettierrc|codecov\.yml|Dockerfile|eslint\.config\.js|Makefile|rustfmt\.toml|vitest\.config\.ts)$/,
  /^(tsconfig\.build-types\.json|vite\.docs-demo\.config\.ts|vite\.lib\.config\.ts)$/,
];

export const JUPYTERLAB_ONLY = [
  /^(crates\/megane-python|jupyterlab-megane|python|wheel-share)\//,
  /^(pyproject\.toml|uv\.lock|vite\.builder-widget\.config\.ts|vite\.widget\.config\.ts)$/,
];

const matches = (patterns, path) => patterns.some((re) => re.test(path));

/**
 * Which host groups the changed paths can reach, with the first path that
 * reaches each (null when none does).
 * @param {string[]} paths
 * @returns {{ webapp: string | null, jupyterlab: string | null }}
 */
export function e2eScope(paths) {
  const scope = { webapp: null, jupyterlab: null };
  for (const path of paths) {
    if (matches(NO_E2E, path)) continue;
    scope.jupyterlab ??= path;
    if (!matches(JUPYTERLAB_ONLY, path)) scope.webapp ??= path;
  }
  return scope;
}

/** `key=value` lines for $GITHUB_OUTPUT. */
export function outputLines(scope) {
  return `webapp=${scope.webapp !== null}\njupyterlab=${scope.jupyterlab !== null}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const paths = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const scope = e2eScope(paths);
  for (const host of ["webapp", "jupyterlab"]) {
    console.log(
      scope[host] === null
        ? `${host}: skip — none of the ${paths.length} changed paths can reach it`
        : `${host}: run — ${scope[host]} can reach it`,
    );
  }
  const lines = outputLines(scope);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}
