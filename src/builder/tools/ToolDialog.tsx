/**
 * The form of one tool (§4.1), in the Details panel: generated from its `inputSchema`, run against
 * the connected server, closed when the result has been applied. Errors keep
 * the form open with the user's values (§6), and the values are remembered
 * per tool for the session (`ToolsStore.formValues`), so a reopened form
 * shows them again. Enter in a field runs the tool; a tool whose result
 * replaces the document asks first when there are unsaved edits.
 */

import { useMemo, useState } from "react";
import { DetailForm } from "../DetailForm";
import { confirmDiscard, shownSnapshot } from "../store";
import { allMolecules, useLibraryStore } from "../library/store";
import { buttonStyle, hintStyle, rowStyle } from "../styles";
import type { BuilderToolInfo } from "./contract";
import { buildArguments, initialValues, validate, type FormContext, type FormValues } from "./form";
import { Fields } from "./ToolFields";
import { useBuilderStoreApi, useScopedBuilderStore, useScopedToolsStore } from "../BuilderStores";

export function ToolDialog({ tool }: { tool: BuilderToolInfo }) {
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const selected = useScopedBuilderStore((s) => s.selected);
  const edits = useScopedBuilderStore((s) => s.edits);
  const user = useLibraryStore((s) => s.user);
  const running = useScopedToolsStore((s) => s.running);
  const run = useScopedToolsStore((s) => s.run);
  const cancel = useScopedToolsStore((s) => s.cancel);
  const closeForm = useScopedToolsStore((s) => s.closeForm);
  const remembered = useScopedToolsStore((s) => s.formValues[tool.name]);
  const rememberValues = useScopedToolsStore((s) => s.rememberValues);
  const builder = useBuilderStoreApi();

  const shown = useMemo(
    () => shownSnapshot({ source, result, showOriginal }),
    [source, result, showOriginal],
  );
  const ctx: FormContext = useMemo(
    () => ({ library: allMolecules({ user }), shown, selected }),
    [user, shown, selected],
  );
  const fields = tool.fields ?? [];
  const [values, setValuesState] = useState<FormValues>(
    () => remembered ?? initialValues(fields, ctx),
  );
  const setValues = (next: FormValues) => {
    setValuesState(next);
    rememberValues(tool.name, next);
  };
  const [error, setError] = useState<string | null>(null);
  const busy = running?.tool.name === tool.name;

  const problem = validate(fields, values, ctx);
  const insertBlocked = tool.apply === "insert" && !(source && result && !showOriginal);

  const blocked = !!problem || insertBlocked || busy;
  const submit = async () => {
    if (blocked) return;
    setError(null);
    if (
      tool.apply === "new_document" &&
      !(await confirmDiscard(builder, `Running ${tool.label}`))
    ) {
      return;
    }
    const outcome = await run(tool, buildArguments(fields, values, ctx));
    if (!outcome.ok) setError(outcome.error);
  };

  return (
    <DetailForm
      testId="builder-tool-dialog"
      title={tool.label}
      onClose={closeForm}
      closeTestId="builder-tool-close"
      closeDisabled={busy}
    >
      <div style={{ ...hintStyle, whiteSpace: "pre-wrap" }} data-testid="builder-tool-description">
        {tool.description}
      </div>
      <form
        data-testid="builder-tool-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <Fields
          fields={fields}
          values={values}
          onChange={setValues}
          ctx={ctx}
          testPrefix="builder-tool-field"
        />
        {tool.apply === "new_document" && source && edits.length > 0 && (
          <div
            style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
            data-testid="builder-tool-replaces"
          >
            The result replaces the open structure and its history.
          </div>
        )}
        {insertBlocked && (
          <div
            style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
            data-testid="builder-tool-needs-document"
          >
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
                  background: "var(--megane-primary)",
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
            style={{
              ...hintStyle,
              color: error
                ? "var(--megane-danger-text, #b91c1c)"
                : "var(--megane-warning-text, #b45309)",
            }}
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
              type="submit"
              data-testid="builder-tool-run"
              style={buttonStyle("primary", !!problem || insertBlocked)}
              disabled={!!problem || insertBlocked}
              title={problem ?? (insertBlocked ? "Open or create a structure first" : undefined)}
            >
              Run
            </button>
          )}
        </div>
      </form>
    </DetailForm>
  );
}
