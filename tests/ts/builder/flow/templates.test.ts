/**
 * The Flow rail's templates: each is a valid flow file whose wires land on
 * real inputs, and each runs end to end — the built-in blocks for real, the
 * tools against the reference server's recorded answers.
 */

import { describe, it, expect } from "vitest";
import { runFlow } from "@/builder/flow/engine";
import { blockPorts } from "@/builder/flow/ports";
import { parseSerializedFlow } from "@/builder/flow/store";
import { FLOW_TEMPLATES, TEMPLATE_SEED } from "@/builder/flow/templates";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import type { PolymerParams, ToolParams } from "@/builder/flow/types";
import { fakeDeps, tools } from "./helpers";

describe("FLOW_TEMPLATES", () => {
  it("have unique ids, labels and descriptions", () => {
    const ids = FLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of FLOW_TEMPLATES) {
      expect(t.label).not.toBe("");
      expect(t.description).not.toBe("");
    }
  });

  it.each(FLOW_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s is a flow file whose wires reach real inputs",
    (_, template) => {
      const flow = parseSerializedFlow(JSON.parse(JSON.stringify(template.create())));
      const used = new Set<string>();
      for (const e of flow.edges) {
        const target = flow.nodes.find((n) => n.id === e.target)!;
        const params = target.params;
        const tool = params.type === "tool" ? tools[params.tool] : null;
        if (params.type === "tool") used.add(params.tool);
        const port = blockPorts(params, tool, []).find((p) => p.key === e.targetHandle);
        expect(port, `${e.source} → ${e.target}.${e.targetHandle}`).toBeDefined();
      }
      expect([...used].sort()).toEqual([...template.tools].sort());
      for (const n of flow.nodes) {
        if (n.params.type === "molecule" && n.params.source === "library") {
          expect(PRESET_MOLECULES.some((m) => m.id === n.params.libraryId)).toBe(true);
        }
        if (n.params.type === "tool") expect(n.params.values.seed).toBe(TEMPLATE_SEED);
      }
    },
  );

  it.each(FLOW_TEMPLATES.map((t) => [t.id, t] as const))("%s runs end to end", async (_, t) => {
    const flow = t.create();
    const graph = {
      nodes: flow.nodes.map((n) => ({ id: n.id, data: { params: n.params } })),
      edges: flow.edges.map((e, k) => ({ id: `e${k}`, ...e })),
    };
    const deps = fakeDeps({ library: () => [...PRESET_MOLECULES] });
    const runs = await runFlow(
      graph,
      deps,
      {},
      {
        signal: new AbortController().signal,
        onUpdate: () => {},
      },
    );
    for (const n of flow.nodes) {
      expect(runs[n.id], `${n.id}: ${runs[n.id]?.error}`).toMatchObject({ status: "done" });
    }
    expect(deps.calls.map((c) => c.name).sort()).toEqual([...t.tools].sort());
    // The tool's own defaults fill the settings the template leaves out.
    for (const c of deps.calls) expect(c.args.seed).toBe(TEMPLATE_SEED);
  });

  it("polymer-melt packs into a box longer than a fully extended chain", () => {
    // packmol moves each chain as one rigid conformer, so the box must hold
    // the most extended one RDKit can embed. A polyethylene chain of n units
    // is C(2n)H(4n+2); all-trans it spans (2n − 1) C–C bonds of 1.26 Å along
    // its axis plus ~1 Å of hydrogen at each end.
    const flow = FLOW_TEMPLATES.find((t) => t.id === "polymer-melt")!.create();
    const chainNode = flow.nodes.find((n) => n.params.type === "polymer")!;
    const chain = chainNode.params as PolymerParams;
    const box = flow.nodes.find((n) => n.params.type === "tool")!.params as ToolParams;
    expect(chain.repeatUnit).toBe("*CC*");
    const count = box.rows.components[chainNode.id].count as number;
    const density = box.values.density as number;
    const n = chain.length;
    const molarMass = 2 * n * 12.011 + (4 * n + 2) * 1.008;
    const volume = ((count * molarMass) / 6.02214076e23 / density) * 1e24;
    const edge = Math.cbrt(volume);
    const extended = (2 * n - 1) * 1.26 + 2;
    const tolerance = 2;
    expect(edge).toBeGreaterThan(extended + 2 * tolerance);
  });
});
