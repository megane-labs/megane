/**
 * Form state for a tool's generated form: initial values (§4.1 defaults,
 * examples, widget pre-fills), validation, and the arguments sent to the
 * server. Pure functions, so the dialog only renders.
 *
 * Form values are what the controls hold: a `molecule` field holds a library
 * molecule id, `document` and `selection` hold nothing (they are filled from
 * the Builder when the arguments are built).
 */

import type { Snapshot } from "../../types";
import type { LibraryMolecule } from "../library/types";
import type { FieldSpec } from "./contract";
import { moleculeArgument, snapshotToStructure } from "./payload";

export type FormValues = Record<string, unknown>;

export interface FormContext {
  library: LibraryMolecule[];
  /** The structure on screen, or null when no document is open. */
  shown: Snapshot | null;
  /** Rendered-atom indices selected in the 3D view. */
  selected: number[];
}

/** A fresh seed for a `seed` widget (§4.2). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function cellDiagonal(shown: Snapshot | null): number[] {
  const box = shown?.box;
  return box ? [box[0], box[4], box[8]] : [20, 20, 20];
}

function initialValue(field: FieldSpec, ctx: FormContext): unknown {
  const preset = field.default !== undefined ? field.default : field.example;
  switch (field.kind) {
    case "widget":
      switch (field.widget) {
        case "molecule":
          return ctx.library[0]?.id ?? "";
        case "atom":
          return typeof preset === "number" ? preset : 0;
        case "seed":
          return randomSeed();
        case "element":
          return typeof preset === "number" ? preset : 6;
        case "cell":
          return cellDiagonal(ctx.shown);
        default:
          return undefined;
      }
    case "number":
      if (typeof preset === "number") return preset;
      if (field.min !== null) return field.integer ? Math.ceil(field.min) : field.min;
      return field.integer ? 1 : 0;
    case "enum":
      return typeof preset === "string" && field.options.includes(preset)
        ? preset
        : field.options[0];
    case "string":
      return typeof preset === "string" ? preset : "";
    case "boolean":
      return typeof preset === "boolean" ? preset : false;
    case "vector":
      return Array.isArray(preset) && preset.length === field.length
        ? [...preset]
        : Array.from({ length: field.length }, () => 0);
    case "table": {
      const rows = Math.max(field.minItems, 1);
      return Array.from({ length: rows }, () => initialValues(field.columns, ctx));
    }
    case "group":
      return initialValues(field.fields, ctx);
  }
}

/** Initial values for a list of fields. */
export function initialValues(fields: FieldSpec[], ctx: FormContext): FormValues {
  const out: FormValues = {};
  for (const field of fields) {
    const value = initialValue(field, ctx);
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

/** The library molecule a `molecule` value names. */
export function findMolecule(ctx: FormContext, id: unknown): LibraryMolecule | undefined {
  return ctx.library.find((m) => m.id === id);
}

/** Validate values; returns the first problem, or null. */
export function validate(fields: FieldSpec[], values: FormValues, ctx: FormContext): string | null {
  for (const field of fields) {
    const v = values[field.key];
    const label = field.label;
    switch (field.kind) {
      case "widget":
        if (field.widget === "molecule" && !findMolecule(ctx, v))
          return `Choose a molecule for ${label}.`;
        if (field.widget === "document" && field.required && !ctx.shown) {
          return "This tool works on the open structure; open or create one first.";
        }
        if (field.widget === "atom") {
          const molecule = field.of ? findMolecule(ctx, values[field.of]) : undefined;
          const n = molecule?.elements.length ?? 0;
          if (!Number.isInteger(v) || (v as number) < 0 || (molecule && (v as number) >= n)) {
            return `${label} must be an atom of the chosen molecule.`;
          }
        }
        if ((field.widget === "seed" || field.widget === "element") && !Number.isInteger(v)) {
          return `${label} must be a whole number.`;
        }
        if (
          field.widget === "cell" &&
          !(Array.isArray(v) && v.every((x) => Number.isFinite(x) && x > 0))
        ) {
          return `${label} needs three positive lengths.`;
        }
        break;
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) return `${label} must be a number.`;
        if (field.integer && !Number.isInteger(v)) return `${label} must be a whole number.`;
        if (field.min !== null && (field.exclusiveMin ? v <= field.min : v < field.min)) {
          return `${label} must be ${field.exclusiveMin ? "greater than" : "at least"} ${field.min}.`;
        }
        if (field.max !== null && (field.exclusiveMax ? v >= field.max : v > field.max)) {
          return `${label} must be ${field.exclusiveMax ? "less than" : "at most"} ${field.max}.`;
        }
        break;
      }
      case "vector":
        if (!Array.isArray(v) || !v.every((x) => Number.isFinite(x)))
          return `${label} needs numbers.`;
        break;
      case "string":
        if (field.required && typeof v === "string" && v.trim() === "")
          return `${label} is required.`;
        break;
      case "table": {
        const rows = Array.isArray(v) ? (v as FormValues[]) : [];
        if (rows.length < field.minItems)
          return `${label} needs at least ${field.minItems} row(s).`;
        if (field.maxItems !== null && rows.length > field.maxItems) {
          return `${label} allows at most ${field.maxItems} rows.`;
        }
        for (const row of rows) {
          const problem = validate(field.columns, row, ctx);
          if (problem) return problem;
        }
        break;
      }
      case "group": {
        const problem = validate(field.fields, (v as FormValues) ?? {}, ctx);
        if (problem) return problem;
        break;
      }
      default:
        break;
    }
  }
  return null;
}

/** The `arguments` of the `tools/call` for these values. */
export function buildArguments(
  fields: FieldSpec[],
  values: FormValues,
  ctx: FormContext,
): FormValues {
  const out: FormValues = {};
  for (const field of fields) {
    const v = values[field.key];
    switch (field.kind) {
      case "widget":
        if (field.widget === "document") {
          if (ctx.shown) out[field.key] = snapshotToStructure(ctx.shown);
        } else if (field.widget === "selection") {
          out[field.key] = [...ctx.selected];
        } else if (field.widget === "molecule") {
          const molecule = findMolecule(ctx, v);
          if (molecule) out[field.key] = moleculeArgument(molecule);
        } else if (field.widget === "cell") {
          if (Array.isArray(v) && v.length === 3) {
            const [a, b, c] = v as number[];
            out[field.key] = [a, 0, 0, 0, b, 0, 0, 0, c];
          }
        } else if (v !== undefined) {
          out[field.key] = v;
        }
        break;
      case "table":
        out[field.key] = ((v as FormValues[]) ?? []).map((row) =>
          buildArguments(field.columns, row, ctx),
        );
        break;
      case "group":
        out[field.key] = buildArguments(field.fields, (v as FormValues) ?? {}, ctx);
        break;
      default:
        if (v !== undefined) out[field.key] = v;
    }
  }
  return out;
}
