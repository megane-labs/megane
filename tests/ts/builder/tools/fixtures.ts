/** Recorded responses of the reference tool server (hodakamori/megane-builder-tools, `make fixtures`). */
import toolsList from "../../../fixtures/builder-tools/tools-list.json";
import liquidBox from "../../../fixtures/builder-tools/call-liquid_box.json";
import polymerChain from "../../../fixtures/builder-tools/call-polymer_chain.json";
import solvate from "../../../fixtures/builder-tools/call-solvate.json";
import type { McpTool } from "@/builder/tools/contract";
import type { RawCallResult } from "@/builder/tools/client";

export const TOOLS = toolsList.tools as unknown as McpTool[];

export const CALLS: Record<string, { arguments: Record<string, unknown>; result: RawCallResult }> =
  {
    liquid_box: liquidBox as never,
    polymer_chain: polymerChain as never,
    solvate: solvate as never,
  };
