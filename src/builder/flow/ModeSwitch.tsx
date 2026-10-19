/**
 * The switch between the Builder's two modes, at the head of the left rails:
 * Manual (edit one structure by clicking in the view) and Flow (build a
 * model by connecting blocks). The rails under it follow the mode.
 */

import { RailIcon, railButtonStyle, railStyle } from "../rail";
import type { FlowMode } from "./types";

const IconManual = (
  <RailIcon>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </RailIcon>
);

const IconFlow = (
  <RailIcon>
    <rect x="3" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="16" width="7" height="5" rx="1.5" />
    <path d="M6.5 8v4a2 2 0 0 0 2 2h7a2 2 0 0 1 2 2" />
  </RailIcon>
);

const MODES: { value: FlowMode; label: string; title: string; icon: React.ReactNode }[] = [
  {
    value: "manual",
    label: "Manual",
    title: "Manual: edit the structure by clicking in the view",
    icon: IconManual,
  },
  {
    value: "flow",
    label: "Flow",
    title: "Flow: build a model by connecting blocks (molecules, tools) and running them",
    icon: IconFlow,
  },
];

export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: FlowMode;
  onChange: (mode: FlowMode) => void;
}) {
  return (
    <div
      data-testid="builder-mode-switch"
      role="radiogroup"
      aria-label="Builder mode"
      style={railStyle}
    >
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={mode === m.value}
          aria-label={m.label}
          title={m.title}
          data-testid={`builder-mode-${m.value}`}
          style={{ ...railButtonStyle(mode === m.value), flexDirection: "column", height: 44 }}
          onClick={() => onChange(m.value)}
        >
          {m.icon}
          <span style={{ fontSize: 9, lineHeight: "10px", marginTop: 1 }}>{m.label}</span>
        </button>
      ))}
    </div>
  );
}
