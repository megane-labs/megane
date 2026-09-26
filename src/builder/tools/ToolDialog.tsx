/**
 * The form of one tool (§4.1): generated from its `inputSchema`, run against
 * the connected server, closed when the result has been applied. Errors keep
 * the form open with the user's values (§6).
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getElementSymbol } from "../../constants";
import { useBuilderStore, shownSnapshot } from "../store";
import { allMolecules, useLibraryStore } from "../library/store";
import { buttonStyle, hintStyle, inputStyle, rowStyle } from "../styles";
import { unitLabel, type BuilderToolInfo, type FieldSpec } from "./contract";
import {
  buildArguments,
  findMolecule,
  initialValues,
  randomSeed,
  validate,
  type FormContext,
  type FormValues,
} from "./form";
import { useToolsStore } from "./store";

export function ToolDialog({ tool }: { tool: BuilderToolInfo }) {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const selected = useBuilderStore((s) => s.selected);
  const edits = useBuilderStore((s) => s.edits);
  const user = useLibraryStore((s) => s.user);
  const running = useToolsStore((s) => s.running);
  const run = useToolsStore((s) => s.run);
  const cancel = useToolsStore((s) => s.cancel);
  const closeForm = useToolsStore((s) => s.closeForm);

  const shown = useMemo(
    () => shownSnapshot({ source, result, showOriginal }),
    [source, result, showOriginal],
  );
  const ctx: FormContext = useMemo(
    () => ({ library: allMolecules({ user }), shown, selected }),
    [user, shown, selected],
  );
  const fields = tool.fields ?? [];
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, ctx));
  const [error, setError] = useState<string | null>(null);
  const busy = running?.tool.name === tool.name;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        closeForm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, closeForm]);

  const problem = validate(fields, values, ctx);
  const insertBlocked = tool.apply === "insert" && !(source && result && !showOriginal);

  const submit = async () => {
    setError(null);
    const outcome = await run(tool, buildArguments(fields, values, ctx));
    if (!outcome.ok) setError(outcome.error);
  };

  return createPortal(
    <div
      data-testid="builder-tool-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={tool.label}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) closeForm();
      }}
    >
      <div
        style={{
          width: "min(560px, 94vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 16,
          borderRadius: 10,
          background: "var(--megane-surface-solid, #fff)",
          color: "var(--megane-text, #1e293b)",
          border: "1px solid var(--megane-border-solid, #e2e8f0)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700 }}>{tool.label}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="builder-tool-close"
            style={buttonStyle("default", busy)}
            disabled={busy}
            onClick={closeForm}
          >
            Close
          </button>
        </div>
        <div
          style={{ ...hintStyle, whiteSpace: "pre-wrap" }}
          data-testid="builder-tool-description"
        >
          {tool.description}
        </div>
        <Fields
          fields={fields}
          values={values}
          onChange={setValues}
          ctx={ctx}
          testPrefix="builder-tool-field"
        />
        {tool.apply === "new_document" && source && edits.length > 0 && (
          <div style={{ ...hintStyle, color: "#b45309" }} data-testid="builder-tool-replaces">
            The result replaces the open structure and its history.
          </div>
        )}
        {insertBlocked && (
          <div style={{ ...hintStyle, color: "#b45309" }} data-testid="builder-tool-needs-document">
            This tool adds atoms to the open structure; open or create one first.
          </div>
        )}
        {busy && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
            data-testid="builder-tool-progress"
          >
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "var(--megane-border, rgba(226,232,240,0.8))",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round((running?.fraction ?? 0.05) * 100)}%`,
                  background: "#2563eb",
                  transition: "width 200ms",
                }}
              />
            </div>
            <span style={hintStyle}>{running?.message ?? "Running…"}</span>
          </div>
        )}
        {(error || (problem && !busy)) && (
          <div
            data-testid="builder-tool-error"
            role="alert"
            style={{ ...hintStyle, color: error ? "#b91c1c" : "#b45309" }}
          >
            {error ?? problem}
          </div>
        )}
        <div style={{ ...rowStyle, justifyContent: "flex-end" }}>
          {busy ? (
            <button
              type="button"
              data-testid="builder-tool-cancel"
              style={buttonStyle("danger")}
              onClick={cancel}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              data-testid="builder-tool-run"
              style={buttonStyle("primary", !!problem || insertBlocked)}
              disabled={!!problem || insertBlocked}
              onClick={() => void submit()}
            >
              Run
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface FieldsProps {
  fields: FieldSpec[];
  values: FormValues;
  onChange: (values: FormValues) => void;
  ctx: FormContext;
  testPrefix: string;
}

function Fields({ fields, values, onChange, ctx, testPrefix }: FieldsProps) {
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
        return (
          <label
            key={field.key}
            style={{ display: "flex", flexDirection: "column", gap: 3 }}
            title={field.help ?? undefined}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {field.label}
              {field.required || field.default !== undefined ? "" : " (optional)"}
            </span>
            <Control
              field={field}
              value={values[field.key]}
              onChange={(v) => set(field.key, v)}
              values={values}
              ctx={ctx}
              testId={`${testPrefix}-${field.key}`}
            />
            {field.help && field.kind !== "table" && (
              <span style={{ ...hintStyle, fontSize: 11 }}>{field.help}</span>
            )}
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
  return (
    <div style={hintStyle} data-testid={testId}>
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
}: {
  value: unknown;
  onChange: (v: number) => void;
  testId: string;
  width?: number;
}) {
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
      style={{ ...inputStyle, width }}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === "" ? Number.NaN : Number(e.target.value));
      }}
    />
  );
}

function Suffix({ unit }: { unit: string | null }) {
  const label = unitLabel(unit);
  return label ? <span style={hintStyle}>{label}</span> : null;
}

function Control({ field, value, onChange, values, ctx, testId }: ControlProps) {
  switch (field.kind) {
    case "number":
      return (
        <span style={rowStyle}>
          <NumberInput value={value} onChange={onChange} testId={testId} />
          <Suffix unit={field.unit} />
        </span>
      );
    case "enum":
      return (
        <select
          data-testid={testId}
          style={inputStyle}
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
          style={inputStyle}
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
        <span style={rowStyle}>
          {arr.map((x, k) => (
            <NumberInput
              key={k}
              value={x}
              width={56}
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
  const rows = (value as FormValues[]) ?? [];
  const canAdd = field.maxItems === null || rows.length < field.maxItems;
  const canRemove = rows.length > field.minItems;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row, r) => (
        <div
          key={r}
          data-testid={`${testId}-row-${r}`}
          style={{ ...rowStyle, alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}
        >
          {field.columns.map((col) => (
            <label key={col.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ ...hintStyle, fontSize: 11 }}>{col.label}</span>
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
              style={buttonStyle("danger")}
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
            style={buttonStyle()}
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
  switch (field.widget) {
    case "molecule":
      return (
        <select
          data-testid={testId}
          style={inputStyle}
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
          style={inputStyle}
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
        <span style={rowStyle}>
          <NumberInput value={value} onChange={onChange} testId={testId} />
          <button
            type="button"
            data-testid={`${testId}-reroll`}
            style={buttonStyle()}
            onClick={() => onChange(randomSeed())}
          >
            New seed
          </button>
        </span>
      );
    case "element":
      return (
        <span style={rowStyle}>
          <NumberInput value={value} onChange={onChange} testId={testId} width={56} />
          <span style={hintStyle}>
            {Number.isInteger(value) ? getElementSymbol(value as number) : ""}
          </span>
        </span>
      );
    case "cell": {
      const arr = (value as number[]) ?? [0, 0, 0];
      return (
        <span style={rowStyle}>
          {["a", "b", "c"].map((axis, k) => (
            <span key={axis} style={rowStyle}>
              <span style={hintStyle}>{axis}</span>
              <NumberInput
                value={arr[k]}
                width={56}
                testId={`${testId}-${axis}`}
                onChange={(v) => onChange(arr.map((y, j) => (j === k ? v : y)))}
              />
            </span>
          ))}
          <span style={hintStyle}>Å</span>
        </span>
      );
    }
    default:
      return null;
  }
}
