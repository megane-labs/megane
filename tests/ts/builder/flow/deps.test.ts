/** Flow runs reach RDKit, the library, the Manual document and the tool server of one Builder. */
import { describe, it, expect, vi } from "vitest";

const { embedSketch, parseStructureText } = vi.hoisted(() => ({
  embedSketch: vi.fn(async () => ({ molblock: "MOLBLOCK" })),
  parseStructureText: vi.fn(async () => ({ snapshot: { nAtoms: 9 } })),
}));
vi.mock("@/builder/library/embed", () => ({ embedSketch }));
vi.mock("@/parsers/structure", () => ({ parseStructureText }));

import { createFlowDeps, embedSmilesWithRDKit } from "@/builder/flow/deps";
import { createBuilderStore } from "@/builder/store";
import { createLibraryStore } from "@/builder/library/store";
import { createToolsStore } from "@/builder/tools/store";
import { parseTools } from "@/builder/tools/contract";
import type { ToolConnection } from "@/builder/tools/client";
import { TOOLS } from "../tools/fixtures";
import { recorded, tools, water } from "./helpers";

function setup() {
  const builder = createBuilderStore();
  const library = createLibraryStore(null);
  const tools = createToolsStore({
    connector: vi.fn(),
    builder,
    storage: null,
  });
  return { builder, library, tools, deps: createFlowDeps({ builder, tools, library }) };
}

describe("embedSmilesWithRDKit", () => {
  it("embeds the SMILES and parses the mol block", async () => {
    const snap = await embedSmilesWithRDKit("CCO");
    expect(embedSketch).toHaveBeenCalledWith("CCO");
    expect(parseStructureText).toHaveBeenCalledWith("MOLBLOCK", "smiles.mol");
    expect(snap).toEqual({ nAtoms: 9 });
  });
});

describe("createFlowDeps", () => {
  it("lists the presets and the user's molecules", () => {
    const { deps, library } = setup();
    const before = deps.library().length;
    library.getState().addMolecule({
      name: "mine",
      formula: "H2O",
      origin: "file",
      elements: [8, 1, 1],
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      bonds: [],
    });
    expect(deps.library().length).toBe(before + 1);
    expect(deps.embedSmiles).toBe(embedSmilesWithRDKit);
  });

  it("gives the Manual document with a key that follows it", () => {
    const { deps, builder } = setup();
    expect(deps.document()).toBeNull();
    builder.getState().openStructure(water(), null, "w.xyz");
    const first = deps.document()!;
    expect(first.data).toMatchObject({ name: "w.xyz", labels: null });
    expect(deps.document()!.key).toBe(first.key);
    builder.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    expect(deps.document()!.key).not.toBe(first.key);
    builder.setState({ fileName: null });
    expect(deps.document()!.data.name).toBe("untitled");
  });

  it("finds tools and calls them on the connection", async () => {
    const { deps, tools: store } = setup();
    expect(deps.tool("liquid_box")).toBeNull();
    const result = await deps.call(tools.liquid_box, {}, { timeoutMs: 1 });
    expect(result).toEqual({ ok: false, error: "Not connected to a tool server." });
    const call = vi.fn(async () => recorded("liquid_box"));
    const connection: ToolConnection = {
      serverName: "fake",
      serverVersion: null,
      listing: parseTools(TOOLS),
      call,
      close: async () => {},
    };
    store.setState({ connection });
    expect(deps.tool("liquid_box")!.label).toBe("Liquid box");
    expect(deps.tool("nope")).toBeNull();
    await deps.call(tools.liquid_box, { seed: 1 }, { timeoutMs: 5 });
    expect(call).toHaveBeenCalledWith("liquid_box", { seed: 1 }, { timeoutMs: 5 });
  });
});
