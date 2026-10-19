/**
 * The controls of a tool's generated form (§4.1, §4.2): one control per
 * `FieldSpec`, tables and groups included. Pure UI over `form.ts`.
 *
 * Two hosts draw these forms, each in its own look (`FieldsLookContext`):
 * the Builder's Details panel stacks every label over its control in the
 * Builder's controls (the default), and Flow mode's properties pane lays them
 * out as the viewer's node-form rows (`NODE_FORM_LOOK`), so a tool block's
 * settings read like any other node's.
 */

import { createContext, useContext, useEffect, useState, type CSSProperties } from "react";
import { getElementSymbol } from "../../constants";
import { Field } from "../../components/nodes/form";
import {
  LABEL_WIDTH,
  fieldLabelStyle,
  hintStyle as nodeHintStyle,
  inputStyle as nodeInputStyle,
  nodeButtonStyle,
  selectStyle as nodeSelectStyle,
} from "../../components/nodes/formStyles";
import { buttonStyle, hintStyle, inputStyle, rowStyle, type ButtonVariant } from "../styles";
import { unitLabel, type FieldSpec } from "./contract";
import { findMolecule, initialValues, randomSeed, type FormContext, type FormValues } from "./form";

/** How the form's labels and controls are drawn. */
export interface FieldsLook {
  /** `stack`: label over control; `rows`: the viewer's label-beside-control rows. */
  layout: "stack" | "rows";
  gap: number;
  label: CSSProperties;
  help: CSSProperties;
  hint: CSSProperties;
  input: CSSProperties;
  select: CSSProperties;
  row: CSSProperties;
  button: (variant: ButtonVariant) => CSSProperties;
}

/** The Builder's own look: its Details panel. */
export const BUILDER_FORM_LOOK: FieldsLook = {
  layout: "stack",
  gap: 8,
  label: { fontSize: 12, fontWeight: 600 },
  help: { ...hintStyle, fontSize: 11 },
  hint: hintStyle,
  input: inputStyle,
  select: inputStyle,
  row: rowStyle,
  button: (variant) => buttonStyle(variant),
};

/** The viewer's node-form look: the pipeline editor's properties pane. */
export const NODE_FORM_LOOK: FieldsLook = {
  layout: "rows",
  gap: 10,
  label: fieldLabelStyle,
  help: nodeHintStyle,
  hint: nodeHintStyle,
  input: nodeInputStyle,
  select: nodeSelectStyle,
  row: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, width: "100%" },
  button: (variant) => ({
    ...nodeButtonStyle,
    width: "auto",
    ...(variant === "danger" ? { color: "var(--megane-danger-text)" } : {}),
  }),
};

export const FieldsLookContext = createContext<FieldsLook>(BUILDER_FORM_LOOK);

export interface FieldsProps {
  fields: FieldSpec[];
  values: FormValues;
  onChange: (values: FormValues) => void;
  ctx: FormContext;
  testPrefix: string;
}

export function Fields({ fields, values, onChange, ctx, testPrefix }: FieldsProps) {
  const look = useContext(FieldsLookContext);
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: look.gap }}>
      {fields.map((field) => {
        if (
          field.kind === "widget" &&
          (field.widget === "document" || field.widget === "selection")
        ) {
          return (
            <AutoField
              key={field.key}
              field={field}
              ctx={ctx}
              testId={`${testPrefix}-${field.key}`}
            />
          );
        }
        const label = `${field.label}${field.required || field.default !== undefined ? "" : " (optional)"}`;
        const control = (
          <Control
            field={field}
            value={values[field.key]}
            onChange={(v) => set(field.key, v)}
            values={values}
            ctx={ctx}
            testId={`${testPrefix}-${field.key}`}
          />
        );
        const help = field.help && field.kind !== "table" && (
          <span style={look.help}>{field.help}</span>
        );
        // A row (the viewer's node forms) for a single control; a table or a
        // group, or the stacked look, puts the label over its control.
        if (look.layout === "rows" && field.kind !== "table" && field.kind !== "group") {
          return (
            <div
              key={field.key}
              style={{ display: "flex", flexDirection: "column", gap: 3 }}
              title={field.help ?? undefined}
            >
              <Field label={label}>{control}</Field>
              {help && <div style={{ paddingLeft: LABEL_WIDTH + 10 }}>{help}</div>}
            </div>
          );
        }
        return (
          <label
            key={field.key}
            style={{ display: "flex", flexDirection: "column", gap: 3 }}
            title={field.help ?? undefined}
          >
            <span style={look.label}>{label}</span>
            {control}
            {help}
          </label>
        );
      })}
    </div>
  );
}

function AutoField({ field, ctx, testId }: { field: FieldSpec; ctx: FormContext; testId: string }) {
  const text =
    field.kind === "widget" && field.widget === "selection"
      ? `${field.label}: ${ctx.selected.length} selected atom(s) from the 3D view.`
      : ctx.shown
        ? `Uses the open structure (${ctx.shown.nAtoms} atoms).`
        : "Uses the open structure (none is open).";
  const look = useContext(FieldsLookContext);
  return (
    <div style={look.hint} data-testid={testId}>
      {text}
    </div>
  );
}

interface ControlProps {
  field: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Sibling values, for an `atom` field's molecule. */
  values: FormValues;
  ctx: FormContext;
  testId: string;
}

function NumberInput({
  value,
  onChange,
  testId,
  width = 90,
  narrow = false,
}: {
  value: unknown;
  onChange: (v: number) => void;
  testId: string;
  width?: number;
  /** One of several in a row (a vector's components): keeps `width` in every look. */
  narrow?: boolean;
}) {
  const look = useContext(FieldsLookContext);
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      data-testid={testId}
      style={{ ...look.input, width: look.layout === "rows" && !narrow ? "100%" : width }}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === "" ? Number.NaN : Number(e.target.value));
      }}
    />
  );
}

function Suffix({ unit }: { unit: string | null }) {
  const look = useContext(FieldsLookContext);
  const label = unitLabel(unit);
  return label ? <span style={{ ...look.hint, whiteSpace: "nowrap" }}>{label}</span> : null;
}

function Control({ field, value, onChange, values, ctx, testId }: ControlProps) {
  const look = useContext(FieldsLookContext);
  switch (field.kind) {
    case "number":
      return (
        <span style={look.row}>
          <NumberInput value={value} onChange={onChange} testId={testId} />
          <Suffix unit={field.unit} />
        </span>
      );
    case "enum":
      return (
        <select
          data-testid={testId}
          style={look.select}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "string":
      return (
        <input
          data-testid={testId}
          style={look.input}
          maxLength={field.maxLength ?? undefined}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          data-testid={testId}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          style={{ alignSelf: "flex-start" }}
        />
      );
    case "vector": {
      const arr = (value as number[]) ?? [];
      return (
        <span style={look.row}>
          {arr.map((x, k) => (
            <NumberInput
              key={k}
              value={x}
              width={56}
              narrow
              testId={`${testId}-${k}`}
              onChange={(v) => onChange(arr.map((y, j) => (j === k ? v : y)))}
            />
          ))}
          <Suffix unit={field.unit} />
        </span>
      );
    }
    case "group":
      return (
        <div
          style={{ paddingLeft: 10, borderLeft: "2px solid var(--megane-border-solid, #e2e8f0)" }}
        >
          <Fields
            fields={field.fields}
            values={(value as FormValues) ?? {}}
            onChange={onChange}
            ctx={ctx}
            testPrefix={testId}
          />
        </div>
      );
    case "table":
      return (
        <TableControl field={field} value={value} onChange={onChange} ctx={ctx} testId={testId} />
      );
    case "widget":
      return (
        <WidgetControl
          field={field}
          value={value}
          onChange={onChange}
          values={values}
          ctx={ctx}
          testId={testId}
        />
      );
  }
}

function TableControl({
  field,
  value,
  onChange,
  ctx,
  testId,
}: Omit<ControlProps, "values"> & { field: Extract<FieldSpec, { kind: "table" }> }) {
  const look = useContext(FieldsLookContext);
  const rows = (value as FormValues[]) ?? [];
  const canAdd = field.maxItems === null || rows.length < field.maxItems;
  const canRemove = rows.length > field.minItems;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row, r) => (
        <div
          key={r}
          data-testid={`${testId}-row-${r}`}
          style={{ ...look.row, alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}
        >
          {field.columns.map((col) => (
            <label key={col.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={look.help}>{col.label}</span>
              <Control
                field={col}
                value={row[col.key]}
                values={row}
                ctx={ctx}
                testId={`${testId}-${r}-${col.key}`}
                onChange={(v) =>
                  onChange(rows.map((x, j) => (j === r ? { ...x, [col.key]: v } : x)))
                }
              />
            </label>
          ))}
          {canRemove && (
            <button
              type="button"
              data-testid={`${testId}-remove-${r}`}
              style={look.button("danger")}
              onClick={() => onChange(rows.filter((_, j) => j !== r))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {canAdd && (
        <div>
          <button
            type="button"
            data-testid={`${testId}-add`}
            style={look.button("default")}
            onClick={() => onChange([...rows, initialValues(field.columns, ctx)])}
          >
            Add row
          </button>
        </div>
      )}
    </div>
  );
}

function WidgetControl({
  field,
  value,
  onChange,
  values,
  ctx,
  testId,
}: ControlProps & { field: Extract<FieldSpec, { kind: "widget" }> }) {
  const look = useContext(FieldsLookContext);
  switch (field.widget) {
    case "molecule":
      return (
        <select
          data-testid={testId}
          style={look.select}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {ctx.library.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.formula})
            </option>
          ))}
        </select>
      );
    case "atom": {
      const molecule = field.of ? findMolecule(ctx, values[field.of]) : undefined;
      if (!molecule) return <NumberInput value={value} onChange={onChange} testId={testId} />;
      return (
        <select
          data-testid={testId}
          style={look.select}
          value={String(value ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {molecule.elements.map((z, i) => (
            <option key={i} value={i}>
              {i}: {getElementSymbol(z)}
            </option>
          ))}
        </select>
      );
    }
    case "seed":
      return (
        <span style={look.row}>
          <NumberInput value={value} onChange={onChange} testId={testId} />
          <button
            type="button"
            data-testid={`${testId}-reroll`}
            style={{ ...look.button("default"), width: "auto", flexShrink: 0 }}
            onClick={() => onChange(randomSeed())}
          >
            New seed
          </button>
        </span>
      );
    case "element":
      return (
        <span style={look.row}>
          <NumberInput value={value} onChange={onChange} testId={testId} width={56} narrow />
          <span style={look.hint}>
            {Number.isInteger(value) ? getElementSymbol(value as number) : ""}
          </span>
        </span>
      );
    case "cell": {
      const arr = (value as number[]) ?? [0, 0, 0];
      return (
        <span style={look.row}>
          {["a", "b", "c"].map((axis, k) => (
            <span key={axis} style={look.row}>
              <span style={look.hint}>{axis}</span>
              <NumberInput
                value={arr[k]}
                width={56}
                narrow
                testId={`${testId}-${axis}`}
                onChange={(v) => onChange(arr.map((y, j) => (j === k ? v : y)))}
              />
            </span>
          ))}
          <span style={look.hint}>Å</span>
        </span>
      );
    }
    default:
      return null;
  }
}
