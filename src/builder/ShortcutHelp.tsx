/**
 * The keyboard-shortcut card: a form in the Details panel, opened with "?"
 * or File › Keyboard shortcuts…, that lists every key the Builder answers to
 * (`shortcuts.ts`): the tool keys, the document and history keys, and what
 * the modifiers and keys do during a drag in the view. Escape or Close puts
 * the panel back.
 */

import type { CSSProperties } from "react";
import { DetailForm } from "./DetailForm";
import { TOOLS } from "./ToolRail";
import { TOOL_KEYS, dragShortcuts, generalShortcuts, type ShortcutEntry } from "./shortcuts";
import { hintStyle, monoStyle } from "./styles";

export interface ShortcutHelpProps {
  /** ⌘ or Ctrl. */
  mod: string;
  onClose: () => void;
}

const keyStyle: CSSProperties = {
  ...monoStyle,
  fontSize: 11,
  whiteSpace: "nowrap",
  color: "var(--megane-text-body, #334155)",
};

function Section({ title, entries, id }: { title: string; entries: ShortcutEntry[]; id: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ ...hintStyle, fontWeight: 600, textTransform: "uppercase", fontSize: 11 }}>
        {title}
      </div>
      <table data-testid={`builder-shortcuts-${id}`} style={{ borderCollapse: "collapse" }}>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.keys}-${e.action}`}>
              <td style={{ ...keyStyle, padding: "2px 12px 2px 0", verticalAlign: "top" }}>
                {e.keys}
              </td>
              <td style={{ fontSize: 12, padding: "2px 0" }}>{e.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ShortcutHelp({ mod, onClose }: ShortcutHelpProps) {
  const tools: ShortcutEntry[] = TOOLS.map((t) => ({
    keys: TOOL_KEYS[t.value],
    action: `${t.label} tool`,
  }));
  return (
    <DetailForm
      testId="builder-shortcuts"
      title="Keyboard shortcuts"
      onClose={onClose}
      closeTestId="builder-shortcuts-close"
    >
      <Section title="Tools" entries={tools} id="tools" />
      <Section title="Document and history" entries={generalShortcuts(mod)} id="general" />
      <Section title="In the view" entries={dragShortcuts(mod)} id="drag" />
      <div style={hintStyle}>Keys are ignored while you type in a field. Esc closes this list.</div>
    </DetailForm>
  );
}
