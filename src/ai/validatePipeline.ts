/**
 * Post-generation validation of a SerializedPipeline's selection queries, plus
 * a repair-prompt builder. The LLM frequently emits `filter` queries that use
 * unsupported syntax (VMD/PyMOL idioms, unquoted strings, etc.); these parse to
 * "select all" or throw at runtime, silently breaking the selection. We catch
 * them up front with the same validators the Filter node UI uses, then ask the
 * model to fix only the broken queries.
 */

import type { SerializedPipeline } from "../pipeline/types";
import { validateQuery, validateBondQuery } from "../pipeline/selection";
import { collectSchemaErrors } from "./pipelineSchema";
import { collectSelfCheckErrors, type SelfCheckContext } from "./selfCheck";

/**
 * Validate every `filter` node's `query` / `bond_query` against the selection
 * DSL grammar. Returns a list of human-readable error strings (one per invalid
 * query), or an empty array when all queries are syntactically valid.
 */
export function collectQueryErrors(pipeline: SerializedPipeline): string[] {
  const errors: string[] = [];
  for (const node of pipeline.nodes) {
    if (node.type !== "filter") continue;
    const n = node as { id: string; query?: unknown; bond_query?: unknown };

    if (typeof n.query === "string") {
      const r = validateQuery(n.query);
      if (!r.valid) {
        errors.push(`node "${n.id}" query \`${n.query}\`: ${r.error ?? "invalid query"}`);
      }
    }

    if (typeof n.bond_query === "string" && n.bond_query.trim() !== "") {
      const r = validateBondQuery(n.bond_query);
      if (!r.valid) {
        errors.push(
          `node "${n.id}" bond_query \`${n.bond_query}\`: ${r.error ?? "invalid bond query"}`,
        );
      }
    }
  }
  return errors;
}

/**
 * Collect every correctness problem with a generated pipeline: structural
 * schema errors (unknown node types, malformed positions, missing/duplicate
 * viewport, dangling edges), invalid selection queries, and — via
 * {@link collectSelfCheckErrors} — the semantic failures that survive both
 * (mistyped edges, overlapping viewport branches, and whatever the executor
 * reports when the pipeline is actually run against `ctx`). This is the single
 * gate the repair round trip checks: a non-empty result means the model should
 * be asked to fix the pipeline.
 *
 * `ctx` carries the structure the user currently has loaded. Omit it (or pass
 * one without a `snapshot`) to run the static checks only — that is the right
 * behaviour when nothing is loaded, and the mode the prompt benchmark uses.
 */
export function collectPipelineErrors(
  pipeline: SerializedPipeline,
  ctx: SelfCheckContext = {},
): string[] {
  const errors = [...collectSchemaErrors(pipeline), ...collectQueryErrors(pipeline)];
  // The self-check deserializes and runs the graph, which is only meaningful
  // once the graph is structurally sound — running it on a pipeline with an
  // unknown node type would just report the same problem in worse words.
  if (errors.length > 0) return errors;
  return collectSelfCheckErrors(pipeline, ctx);
}

/** Cap on how many findings one repair message carries (keeps the turn small). */
export const MAX_REPORTED_ERRORS = 12;

/**
 * Build the follow-up user message asking the model to fix the problems found
 * in the pipeline it just produced.
 *
 * This is sent inside the *same* conversation as the generation, so the
 * original request and the broken pipeline are already in the history and are
 * deliberately not repeated — the model sees its own JSON one turn above, and
 * restating it invites a wholesale rewrite instead of a targeted correction.
 */
export function buildRepairPrompt(errors: string[]): string {
  const shown = errors.slice(0, MAX_REPORTED_ERRORS);
  const omitted = errors.length - shown.length;

  return [
    "The pipeline you just produced has the problems listed below. They were",
    "found by validating it and running it against the loaded structure, so",
    "each one is real — fix them all and return the corrected pipeline.",
    "",
    "Problems:",
    ...shown.map((e) => `- ${e}`),
    ...(omitted > 0 ? [`- … and ${omitted} more of the same kind`] : []),
    "",
    "Change only what is needed to resolve them; keep everything that already",
    "matches the request. Follow the schema and the selection DSL from the",
    "system prompt exactly. Return the corrected pipeline as a single JSON code",
    "block first, then one short sentence describing what it does.",
  ].join("\n");
}
