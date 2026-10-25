/** Shared types of the Flow benchmark. */

import type { SerializedFlow } from "@/builder/flow/store";
import type { FlowRubric } from "./scorer";

/** A structure a case can have open in Manual mode (see `manualStructure`). */
export type ManualStructure = "nacl-cell" | "cu-cell";

/** The Builder a request is made in. */
export interface FlowSetup {
  /** The reference tool server is connected (its recorded tool listing). */
  tools?: boolean;
  /** The structure open in Manual mode; none when omitted. */
  document?: ManualStructure;
  /** A flow already in the graph: the request edits it. */
  flow?: SerializedFlow;
  /** Ids of the blocks selected in that flow. */
  selected?: string[];
}

/** One benchmark case: a request, the Builder it is made in, and how its answer is graded. */
export interface FlowBenchCase {
  /** Stable identifier (reports, result files, `golden.ts`). */
  id: string;
  /** The request, handed to the assistant verbatim. */
  prompt: string;
  /** Category tags for per-group reporting. */
  tags: string[];
  setup: FlowSetup;
  rubric: FlowRubric;
}
