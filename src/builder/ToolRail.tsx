/**
 * The Builder's tool rail: a vertical strip of icon buttons down the left of
 * the 3D view, one per tool, each carrying its shortcut key — the place every
 * molecule editor keeps its tools. The settings a tool uses are not here but
 * in the `ContextBar` over the view, and what a click will do is said once, in
 * the status bar (`toolHint`).
 */

import type { ReactNode } from "react";
import { useBuilderStore } from "./store";
import { TOOL_KEYS } from "./shortcuts";
import type { BuildTool } from "./types";
import type { LibraryMolecule } from "./library/types";

export interface ToolInfo {
  value: BuildTool;
  label: string;
  hint: string;
  /** Which settings the context bar shows for it. */
  needs: ("element" | "bondOrder" | "place")[];
}

export const TOOLS: ToolInfo[] = [
  {
    value: "select",
    label: "Select",
    hint: "Click atoms to select them (Shift adds).",
    needs: [],
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

/** What a click does with `tool` right now, for the status bar. */
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

// 20 px stroke icons, drawn in currentColor so the active tint carries over.
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
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[tool]}
    </svg>
  );
}

export const TOOL_RAIL_WIDTH = 52;

const ACCENT = "#2563eb";

function railButtonStyle(active: boolean): React.CSSProperties {
  return {
    position: "relative",
    width: 38,
    height: 38,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    background: active ? "rgba(37, 99, 235, 0.14)" : "transparent",
    color: active ? ACCENT : "var(--megane-text-secondary, #475569)",
  };
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
      style={{
        width: TOOL_RAIL_WIDTH,
        flexShrink: 0,
        boxSizing: "border-box",
        padding: "8px 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        borderRight: "1px solid var(--megane-border-solid, #e2e8f0)",
        background: "var(--megane-surface-solid, #f8f9fb)",
      }}
    >
      {GROUPS.map((group, g) => (
        <div key={g} style={{ display: "contents" }}>
          {g > 0 && (
            <div
              aria-hidden="true"
              style={{
                width: 26,
                height: 1,
                margin: "4px 0",
                background: "var(--megane-border-solid, #e2e8f0)",
              }}
            />
          )}
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
                    position: "absolute",
                    right: 3,
                    bottom: 1,
                    fontSize: 9,
                    fontWeight: 600,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    color: active ? ACCENT : "#94a3b8",
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
