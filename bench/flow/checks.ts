/**
 * The building blocks of the dataset's result checks: what the output block
 * built (`ExecutionResult.output`) and what the tool calls asked for
 * (`ExecutionResult.calls`). Each returns a labelled `ResultCheck`, so a
 * failed one says in the report what the structure was supposed to be.
 */

import { readMolblock, type ToolCall } from "./environment";
import { summarize, type ExecutionResult, type StructureSummary } from "./execute";
import type { ResultCheck } from "./scorer";

function output(run: ExecutionResult): StructureSummary {
  if (!run.output) throw new Error("no output");
  return run.output;
}

/** The output holds atoms of these elements and no others. */
export function onlyElements(...symbols: string[]): ResultCheck {
  return {
    label: `built only ${symbols.join(", ")}`,
    test: (run) => {
      const present = Object.keys(output(run).elements);
      return present.length === symbols.length && present.every((s) => symbols.includes(s));
    },
  };
}

/** The output holds exactly `n` atoms of `symbol`. */
export function count(symbol: string, n: number): ResultCheck {
  return {
    label: `built ${n} ${symbol}`,
    test: (run) => (output(run).elements[symbol] ?? 0) === n,
  };
}

/** The output holds no atoms of `symbol`. */
export function none(symbol: string): ResultCheck {
  return { label: `built no ${symbol}`, test: (run) => !output(run).elements[symbol] };
}

/** The output holds atoms of `symbol`. */
export function some(symbol: string): ResultCheck {
  return { label: `built ${symbol}`, test: (run) => (output(run).elements[symbol] ?? 0) > 0 };
}

/** The output holds exactly `n` bonds between `a` and `b` atoms (`"O", "H"`: hydroxyl hydrogens). */
export function bondCount(a: string, b: string, n: number): ResultCheck {
  const pair = [a, b].sort().join("-");
  return {
    label: `built ${n} ${a}–${b} bond${n === 1 ? "" : "s"}`,
    test: (run) => (output(run).bonds[pair] ?? 0) === n,
  };
}

/** The output holds as many atoms of `a` as of `b` (a 1:1 compound). */
export function equalCounts(a: string, b: string): ResultCheck {
  return {
    label: `built as many ${a} as ${b}`,
    test: (run) => {
      const e = output(run).elements;
      return (e[a] ?? 0) > 0 && e[a] === e[b];
    },
  };
}

/** The output's atom count is one of `values` (a conventional or a primitive cell, say). */
export function atomsIn(values: number[]): ResultCheck {
  return {
    label: `built ${values.join(" or ")} atoms`,
    test: (run) => values.includes(output(run).atoms),
  };
}

/** The output has (or, with false, has no) unit cell. */
export function cell(expected = true): ResultCheck {
  return {
    label: expected ? "built a periodic cell" : "built no cell",
    test: (run) => output(run).cell === expected,
  };
}

/** The structure a tool's molecule argument (`{ name, molblock }`) describes. */
export function moleculeArg(value: unknown): StructureSummary | null {
  const molblock = (value as { molblock?: unknown } | null)?.molblock;
  if (typeof molblock !== "string") return null;
  return summarize("", readMolblock(molblock));
}

/** The first call to `tool` passes `test`. */
export function called(
  tool: string,
  label: string,
  test: (args: Record<string, unknown>, call: ToolCall) => boolean,
): ResultCheck {
  return {
    label: `${tool}: ${label}`,
    test: (run) => {
      const call = run.calls.find((c) => c.tool === tool);
      return !!call && test(call.args, call);
    },
  };
}

/** A molecule's formula as element counts match `formula` (e.g. `{ C: 2, H: 6, O: 1 }`). */
export function isFormula(
  molecule: StructureSummary | null,
  formula: Record<string, number>,
): boolean {
  if (!molecule) return false;
  const keys = Object.keys(molecule.elements);
  return (
    keys.length === Object.keys(formula).length &&
    keys.every((k) => molecule.elements[k] === formula[k])
  );
}
