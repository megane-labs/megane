/**
 * Guards the npm publish workflow's authentication path.
 *
 * The npm package is published from GitHub Actions with provenance enabled.
 * Supplying a stale/insufficient NODE_AUTH_TOKEN forces npm back onto token
 * auth and bypasses trusted publishing, which then fails with 403 even though
 * the workflow has OIDC permissions. Keep the publish step tokenless so npm can
 * use GitHub's trusted publishing flow.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/publish-npm.yml"), "utf8");

describe("publish-npm workflow", () => {
  it("publishes with provenance and without forcing NODE_AUTH_TOKEN auth", () => {
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("environment: ${{ (!inputs.dry_run) && 'npm' || '' }}");
    expect(workflow).toContain("run: npm publish --provenance --access public");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
  });
});
