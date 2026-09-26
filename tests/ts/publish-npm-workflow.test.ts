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
import { parse } from "yaml";

const root = path.resolve(__dirname, "../..");
const workflow = parse(
  readFileSync(path.join(root, ".github/workflows/publish-npm.yml"), "utf8"),
) as {
  permissions?: Record<string, string>;
  jobs?: {
    publish?: {
      environment?: string;
      steps?: Array<{
        name?: string;
        run?: string;
        env?: Record<string, string>;
      }>;
    };
  };
};

describe("publish-npm workflow", () => {
  it("publishes with provenance and without forcing NODE_AUTH_TOKEN auth", () => {
    expect(workflow.permissions?.["id-token"]).toBe("write");
    expect(workflow.jobs?.publish?.environment).toBe("${{ (!inputs.dry_run) && 'npm' || '' }}");

    const publishStep = workflow.jobs?.publish?.steps?.find((step) => step.name === "Publish to npm");
    expect(publishStep).toBeDefined();
    expect(publishStep?.run).toBe("npm publish --provenance --access public");
    expect(publishStep?.env).toBeUndefined();
  });
});
