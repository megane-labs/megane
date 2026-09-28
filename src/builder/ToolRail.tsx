/**
 * The Builder's tool rail: a floating frosted-glass column of icon buttons on
 * the left of the 3D view (the viewer's panel look), one per tool, each
 * carrying its shortcut key — the place every molecule editor keeps its
 * tools. The settings a tool uses are not here but in the Details panel on
 * the right (`ContextBar`), and what a click will do is said once, in the
 * status line (`toolHint`).
 */

import type { ReactNode } from "react";
import { useBuilderStore } from "./store";
import { TOOL_KEYS } from "./shortcuts";
import type { BuildTool } from "./types";
import type { LibraryMolecule } from "./library/types";
import { ACCENT_TEXT } from "./styles";
import { RailDivider, RailIcon, railButtonStyle, railCornerMarkStyle, railStyle } from "./rail";

export interface ToolInfo {
  value: BuildTool;
  label: string;
  hint: string;
  /** Which settings the Details panel shows for it. */
  needs: ("select" | "element" | "bondOrder" | "place")[];
}

export const TOOLS: ToolInfo[] = [
  {
    value: "select",
    label: "Select",
    hint: "Click atoms to select them (Shift adds); right-click an atom for more.",
    needs: ["select"],
  },
  { value: "move", label: "Move", hint: "Drag an atom in the screen plane.", needs: [] },
  {
    value: "add",
    label: "Add atom",
    hint: "Click an atom to attach a new one at bond length; click empty space to place it free.",
    needs: ["element", "bondOrder"],
  },
  {
    value: "bond",
    label: "Bond",
    hint: "Click two atoms to bond them (or change the bond order).",
    needs: ["bondOrder"],
  },
  {
    value: "element",
    label: "Element",
    hint: "Click an atom to change it to the chosen element.",
    needs: ["element"],
  },
  {
    value: "delete",
    label: "Delete",
    hint: "Click an atom to remove it with its bonds.",
    needs: [],
  },
  {
    value: "place",
    label: "Place",
    hint: "Click empty space to drop the library molecule there.",
    needs: ["place"],
  },
];

/** The rail's groups, top to bottom: pick and move, edit, stamp a molecule. */
const GROUPS: BuildTool[][] = [["select", "move"], ["add", "bond", "element", "delete"], ["place"]];

export function toolInfo(tool: BuildTool): ToolInfo {
  return TOOLS.find((t) => t.value === tool)!;
}

/** What a click does with `tool` right now, for the status line. */
export function toolHint(
  tool: BuildTool,
  pendingBondAtom: number | null,
  placeSource: Pick<LibraryMolecule, "name"> | null,
): string {
  let hint = toolInfo(tool).hint;
  if (tool === "bond" && pendingBondAtom !== null) hint += ` First atom: #${pendingBondAtom}.`;
  if (tool === "place") {
    hint += placeSource ? ` Placing ${placeSource.name}.` : " Choose a molecule in the library.";
  }
  return hint;
}

// The tools' 20 px stroke icons (see RailIcon).
const ICON_PATHS: Record<BuildTool, ReactNode> = {
  select: <path d="M6 3.5l12 7-5.2 1.6L10.5 18z" />,
  move: (
    <path d="M12 3v18M3 12h18M12 3L9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
  ),
  add: (
    <>
      <circle cx="10" cy="13" r="6" />
      <path d="M19 3.5v6M16 6.5h6" />
    </>
  ),
  bond: (
    <>
      <circle cx="6" cy="17.5" r="3" />
      <circle cx="18" cy="6.5" r="3" />
      <path d="M8.3 15.4l7.4-6.8" />
    </>
  ),
  element: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 16l3-8 3 8M10.1 13.3h3.8" />
    </>
  ),
  delete: (
    <>
      <path d="M14.5 4.5l5 5L11 18H6.5L4 15.5z" />
      <path d="M9 10l5 5" />
      <path d="M12.5 20H20" />
    </>
  ),
  place: (
    <>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <circle cx="12" cy="12" r="3.3" />
    </>
  ),
};

export function ToolIcon({ tool }: { tool: BuildTool }) {
  return <RailIcon>{ICON_PATHS[tool]}</RailIcon>;
}

export function ToolRail() {
  const tool = useBuilderStore((s) => s.tool);
  const setTool = useBuilderStore((s) => s.setTool);

  return (
    <div
      data-testid="builder-tool-rail"
      role="radiogroup"
      aria-label="Tool"
      aria-orientation="vertical"
      style={railStyle}
    >
      {GROUPS.map((group, g) => (
        <div key={g} style={{ display: "contents" }}>
          {g > 0 && <RailDivider />}
          {group.map((value) => {
            const t = toolInfo(value);
            const active = tool === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                data-testid={`builder-tool-${value}`}
                aria-checked={active}
                aria-pressed={active}
                aria-label={`${t.label} (${TOOL_KEYS[value]})`}
                title={`${t.label} (${TOOL_KEYS[value]}) — ${t.hint}`}
                style={railButtonStyle(active)}
                onClick={() => setTool(value)}
              >
                <ToolIcon tool={value} />
                <span
                  aria-hidden="true"
                  style={{
                    ...railCornerMarkStyle,
                    fontSize: 9,
                    fontWeight: 600,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    color: active ? ACCENT_TEXT : "var(--megane-text-muted, #94a3b8)",
                  }}
                >
                  {TOOL_KEYS[value]}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
