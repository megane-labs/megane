/**
 * megane Builder's Python tool buttons (webapp host, `/builder.html`).
 *
 * The tool server is faked with `page.route`: every MCP request to its URL is
 * answered with the responses recorded from the reference server
 * (hodakamori/megane-builder-tools, `tests/fixtures/builder-tools/`). The
 * page therefore runs the real MCP SDK, the real form, and the real apply
 * path into the Builder document, without Python in CI. Asserts DOM and store
 * state rather than pixels.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { test, expect, type Page, type Route } from "playwright/test";

const SERVER = "http://127.0.0.1:18765/mcp";
const TOKEN = "e2e-token";
const FIXTURES = join(process.cwd(), "tests/fixtures/builder-tools");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const TOOLS = fixture("tools-list.json").tools;
const CALLS: Record<string, { result: unknown }> = {
  liquid_box: fixture("call-liquid_box.json"),
  polymer_chain: fixture("call-polymer_chain.json"),
  solvate: fixture("call-solvate.json"),
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

interface RpcMessage {
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

/** A minimal Streamable HTTP MCP server replaying the recorded responses. */
async function fakeToolServer(
  page: Page,
  calls: { name: string; args: Record<string, unknown> }[],
) {
  await page.route(SERVER, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (request.method() !== "POST") return route.fulfill({ status: 405, headers: CORS });
    if (request.headers()["authorization"] !== `Bearer ${TOKEN}`) {
      return route.fulfill({ status: 401, headers: CORS, body: "missing or invalid bearer token" });
    }
    const message = request.postDataJSON() as RpcMessage;
    if (message.id === undefined) return route.fulfill({ status: 202, headers: CORS });
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "megane-builder-tools", version: "0.1.0" },
        };
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = message.params!.name!;
        calls.push({ name, args: message.params!.arguments ?? {} });
        result = CALLS[name].result;
        break;
      }
      default:
        result = {};
    }
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json", "mcp-session-id": "e2e" },
      body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
    });
  });
}

async function builderState(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __megane_test_builder_store: { getState: () => any } })
      .__megane_test_builder_store;
    const s = store.getState();
    return {
      fileName: s.fileName as string | null,
      nAtoms: (s.result?.snapshot.nAtoms ?? null) as number | null,
      nBonds: (s.result?.snapshot.nBonds ?? null) as number | null,
      edits: (s.edits as { op: string }[]).map((e) => e.op),
      notice: (s.notice?.text ?? null) as string | null,
    };
  });
}

test.describe("builder-tools: webapp", () => {
  test("connects from the launch link, builds with every tool, and inserts as one undo step", async ({
    page,
  }) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await fakeToolServer(page, calls);
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
      localStorage.setItem("megane.builder.sections.v1", JSON.stringify({ tools: true }));
    });
    await page.goto(`/builder.html?test=1#tools=${encodeURIComponent(SERVER)}&token=${TOKEN}`);
    await expect(page.getByTestId("builder-tools-list")).toBeVisible();
    await expect(page.getByTestId("builder-section-tools-summary")).toHaveText(
      "megane-builder-tools",
    );
    expect(await page.evaluate(() => location.hash)).toBe("");
    await expect(page.locator('[data-testid^="builder-tools-button-"]')).toHaveText([
      "Liquid box",
      "Polymer chain",
      "Solvate",
    ]);

    // Liquid box → a new document.
    await page.getByTestId("builder-tools-button-liquid_box").click();
    await page.getByTestId("builder-tool-field-components-0-molecule").selectOption("preset:water");
    await page.getByTestId("builder-tool-field-seed").fill("42");
    await page.getByTestId("builder-tool-run").click();
    await expect(page.getByTestId("builder-tool-dialog")).toHaveCount(0);
    expect(calls[0].name).toBe("liquid_box");
    expect(calls[0].args).toMatchObject({ seed: 42, density: 1, shape: "cubic" });
    const component = (
      calls[0].args.components as { molecule: { name: string; molblock: string } }[]
    )[0];
    expect(component.molecule.name).toBe("Water");
    expect(component.molecule.molblock.split("\n")[1].slice(20, 22)).toBe("3D");
    expect(await builderState(page)).toMatchObject({
      fileName: "water",
      nAtoms: 300,
      nBonds: 200,
      edits: [],
    });
    await expect(page.getByTestId("megane-builder")).toHaveAttribute("data-atom-count", "300");

    // Polymer chain: the atom pickers list the chosen monomer's atoms.
    await page.getByTestId("builder-tools-button-polymer_chain").click();
    await page.getByTestId("builder-tool-field-monomer").selectOption("preset:ethanol");
    await expect(page.getByTestId("builder-tool-field-head").locator("option")).toHaveCount(9);
    await page.getByTestId("builder-tool-field-tail").selectOption("1");
    await expect(page.getByTestId("builder-tool-replaces")).toHaveCount(0);
    await page.getByTestId("builder-tool-run").click();
    await expect(page.getByTestId("builder-tool-dialog")).toHaveCount(0);
    expect(calls[1].args).toMatchObject({ head: 0, tail: 1, length: 10 });
    expect((await builderState(page)).fileName).toBe("poly-ethylene");

    // Solvate → one add_fragment into the open document; Undo removes it whole.
    await page.evaluate(() => {
      const s = (
        window as unknown as { __megane_test_builder_store: { getState: () => any } }
      ).__megane_test_builder_store.getState();
      s.newCell(20);
    });
    await page.getByTestId("builder-tools-button-solvate").click();
    await expect(page.getByTestId("builder-tool-field-document")).toContainText("0 atoms");
    await page.getByTestId("builder-tool-run").click();
    await expect(page.getByTestId("builder-tool-dialog")).toHaveCount(0);
    expect(calls[2].args.document).toMatchObject({
      elements: [],
      cell: [20, 0, 0, 0, 20, 0, 0, 0, 20],
    });
    const solvated = await builderState(page);
    expect(solvated.edits).toEqual(["add_fragment"]);
    expect(solvated.nAtoms).toBeGreaterThan(0);
    expect(solvated.notice).toContain("Solvate: added");
    await page.getByTestId("builder-topbar-undo").click();
    expect((await builderState(page)).nAtoms).toBe(0);
  });

  test("a wrong token is reported and nothing connects", async ({ page }) => {
    await fakeToolServer(page, []);
    await page.addInitScript(() => {
      localStorage.setItem("megane.builder.sections.v1", JSON.stringify({ tools: true }));
    });
    await page.goto("/builder.html?test=1");
    await page.getByTestId("builder-tools-url").fill(SERVER);
    await page.getByTestId("builder-tools-token").fill("wrong");
    await page.getByTestId("builder-tools-connect").click();
    await expect(page.getByTestId("builder-tools-error")).toContainText("Could not connect");
    await expect(page.getByTestId("builder-tools-list")).toHaveCount(0);
  });
});
