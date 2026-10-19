/**
 * The Pipeline panel's rail: a column of icon buttons down the panel's left
 * edge, made like megane Builder's tool and operations rails (same 38 px
 * buttons, 20 px stroke icons, rules between groups, ▸ on a button that opens
 * a menu, menus opening to its right). Top to bottom:
 *
 *   Editor, Inspector           — what the panel shows (its tabs; the AI
 *                                 assistant is docked inside the Editor)
 *   Add node, Templates, Layout — build the graph (they show the Editor)
 *   File, Render                — import / export / share, and render
 *   Guide, Tutorial, Theme      — help and appearance, at the foot
 */

import type { CSSProperties, ReactNode } from "react";
import type { PipelinePanelMode } from "../stores/usePipelineUIStore";
import type { NodeCategory, PipelineNodeType } from "../pipeline/types";
import { NODE_CATEGORY_COLORS, NODE_TYPE_LABELS } from "../pipeline/types";
import { PIPELINE_TEMPLATES } from "../pipeline/templates";
import { CATEGORY_ICONS } from "./nodes/categoryIcons";
import { ThemeCycleButton } from "./ThemeCycleButton";
import { Menu, type MenuItem } from "../builder/Menu";
import {
  FlyoutMark,
  RailDivider,
  RailIcon,
  TOOL_RAIL_WIDTH,
  railButtonStyle,
} from "../builder/rail";

export const PIPELINE_RAIL_WIDTH = TOOL_RAIL_WIDTH;

export const ADD_NODE_GROUPS: {
  category: NodeCategory;
  label: string;
  types: PipelineNodeType[];
}[] = [
  {
    category: "data_load",
    label: "Data Load",
    types: ["load_structure", "load_trajectory", "load_vector", "streaming"],
  },
  { category: "data_load", label: "Volumetric", types: ["load_volumetric"] },
  { category: "data_load", label: "Spectrum", types: ["load_spectrum", "spectrum_plot"] },
  { category: "bond", label: "Bond", types: ["add_bond", "coordination_generator"] },
  { category: "filter", label: "Filter", types: ["filter"] },
  {
    category: "modify",
    label: "Modify",
    types: [
      "modify",
      "color",
      "representation",
      "symmetry",
      "wrap",
      "replicate",
      "drawing_boundary",
      "boundary_completion",
    ],
  },
  {
    category: "overlay",
    label: "Overlay",
    types: ["label_generator", "polyhedron_generator", "vector_overlay", "isosurface"],
  },
];

const MODES: { value: PipelinePanelMode; label: string; title: string; icon: ReactNode }[] = [
  {
    value: "editor",
    label: "Editor",
    title: "Editor: the node graph and the selected node's properties",
    icon: (
      <RailIcon>
        <rect x="3" y="3.5" width="7" height="5" rx="1.2" />
        <rect x="14" y="9.5" width="7" height="5" rx="1.2" />
        <rect x="3" y="15.5" width="7" height="5" rx="1.2" />
        <path d="M10 6h2a2 2 0 0 1 2 2v1.5M10 18h2a2 2 0 0 0 2-2v-1.5" />
      </RailIcon>
    ),
  },
  {
    value: "inspector",
    label: "Inspector",
    title: "Inspector: restyle the structure or a selection of it",
    icon: (
      <RailIcon>
        <path d="M4 6h9M4 11h6M4 16h5" />
        <circle cx="16" cy="15" r="4" />
        <path d="M19 18l2.5 2.5" />
      </RailIcon>
    ),
  },
];

const IconAdd = (
  <RailIcon>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </RailIcon>
);

const IconTemplates = (
  <RailIcon>
    <path d="M12 3l9 4.5-9 4.5-9-4.5z" />
    <path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" />
  </RailIcon>
);

const IconLayout = (
  <RailIcon>
    <rect x="9" y="3" width="6" height="4.5" rx="1" />
    <rect x="3" y="16.5" width="6" height="4.5" rx="1" />
    <rect x="15" y="16.5" width="6" height="4.5" rx="1" />
    <path d="M12 7.5V12M6 16.5V12h12v4.5" />
  </RailIcon>
);

const IconFile = (
  <RailIcon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </RailIcon>
);

const IconRender = (
  <RailIcon>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.5-2.5h7.4L17.2 7h2.3A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </RailIcon>
);

const IconGuide = (
  <RailIcon>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 2.5M12 16.8h.01" />
  </RailIcon>
);

const IconTutorial = (
  <RailIcon>
    <path d="M2.5 4.5h6a3.5 3.5 0 0 1 3.5 3.5v12a2.5 2.5 0 0 0-2.5-2.5h-7z" />
    <path d="M21.5 4.5h-6A3.5 3.5 0 0 0 12 8v12a2.5 2.5 0 0 1 2.5-2.5h7z" />
  </RailIcon>
);

/** The menu row of a template: its name over a one-line description. */
function TemplateLabel({ label, description }: { label: string; description: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 1, whiteSpace: "normal" }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 10.5, color: "var(--megane-text-muted)", maxWidth: 240 }}>
        {description}
      </span>
    </span>
  );
}

const railColumnStyle: CSSProperties = {
  width: PIPELINE_RAIL_WIDTH,
  flexShrink: 0,
  boxSizing: "border-box",
  padding: "6px 0",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  overflowY: "auto",
  overflowX: "hidden",
  borderRight: "1px solid var(--megane-border)",
};

function RailButton({
  testId,
  label,
  title,
  icon,
  onClick,
}: {
  testId: string;
  label: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={title}
      style={railButtonStyle(false)}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export interface PipelineRailProps {
  mode: PipelinePanelMode;
  onModeChange: (mode: PipelinePanelMode) => void;
  onAddNode: (type: PipelineNodeType) => void;
  onApplyTemplate: (templateId: string) => void;
  onAutoLayout: () => void;
  onImport: () => void;
  onExport: () => void;
  onShare: () => void;
  onRender: () => void;
  onGuide: () => void;
  onTutorial: () => void;
}

export function PipelineRail({
  mode,
  onModeChange,
  onAddNode,
  onApplyTemplate,
  onAutoLayout,
  onImport,
  onExport,
  onShare,
  onRender,
  onGuide,
  onTutorial,
}: PipelineRailProps) {
  const addItems: MenuItem[] = ADD_NODE_GROUPS.flatMap((group, i) => [
    ...(i > 0 ? [{ separator: true as const }] : []),
    {
      caption: (
        <>
          <span style={{ color: NODE_CATEGORY_COLORS[group.category], lineHeight: 0 }}>
            {CATEGORY_ICONS[group.category]}
          </span>
          {group.label}
        </>
      ),
    },
    ...group.types.map((type) => ({
      label: NODE_TYPE_LABELS[type],
      testId: `pipeline-add-${type}`,
      onSelect: () => onAddNode(type),
    })),
  ]);

  const templateItems: MenuItem[] = PIPELINE_TEMPLATES.map((template) => ({
    label: <TemplateLabel label={template.label} description={template.description} />,
    testId: `pipeline-template-${template.id}`,
    onSelect: () => onApplyTemplate(template.id),
  }));

  const fileItems: MenuItem[] = [
    { label: "Import pipeline…", testId: "pipeline-editor-import", onSelect: onImport },
    { label: "Export pipeline", testId: "pipeline-editor-export", onSelect: onExport },
    { separator: true },
    { label: "Copy share link…", testId: "pipeline-editor-share", onSelect: onShare },
  ];

  const menu = (
    testId: string,
    label: string,
    title: string,
    icon: ReactNode,
    items: MenuItem[],
  ) => (
    <Menu
      testId={testId}
      label={
        <>
          {icon}
          <FlyoutMark />
        </>
      }
      ariaLabel={label}
      title={title}
      placement="right"
      caret={false}
      triggerStyle={railButtonStyle(false)}
      openTriggerStyle={railButtonStyle(true)}
      heading={label}
      items={items}
    />
  );

  return (
    <div
      data-testid="pipeline-rail"
      role="toolbar"
      aria-label="Pipeline"
      aria-orientation="vertical"
      style={railColumnStyle}
    >
      <div
        role="tablist"
        aria-label="Pipeline panel mode"
        aria-orientation="vertical"
        style={{ display: "contents" }}
      >
        {MODES.map((m) => {
          const active = m.value === mode;
          return (
            <button
              key={m.value}
              type="button"
              role="tab"
              id={`pipeline-tab-${m.value}`}
              aria-selected={active}
              aria-controls={`pipeline-tabpanel-${m.value}`}
              aria-label={m.label}
              data-testid={`pipeline-editor-tab-${m.value}`}
              title={m.title}
              style={railButtonStyle(active)}
              onClick={() => onModeChange(m.value)}
            >
              {m.icon}
            </button>
          );
        })}
      </div>
      <RailDivider />
      {menu("pipeline-editor-add", "Add Node", "Add Node", IconAdd, addItems)}
      {menu(
        "pipeline-editor-templates",
        "Templates",
        "Templates: replace the pipeline with a ready-made one",
        IconTemplates,
        templateItems,
      )}
      <RailButton
        testId="pipeline-editor-layout"
        label="Auto Layout"
        title="Auto Layout"
        icon={IconLayout}
        onClick={onAutoLayout}
      />
      <RailDivider />
      {menu(
        "pipeline-editor-file",
        "File",
        "File: import, export or share the pipeline",
        IconFile,
        fileItems,
      )}
      <RailButton
        testId="pipeline-editor-render"
        label="Render"
        title="Render an image or video"
        icon={IconRender}
        onClick={onRender}
      />
      <div style={{ flex: 1, minHeight: 6 }} />
      <RailButton
        testId="pipeline-editor-guide"
        label="Show user guide"
        title="Show user guide"
        icon={IconGuide}
        onClick={onGuide}
      />
      <RailButton
        testId="pipeline-editor-tutorial"
        label="Open pipeline tutorial"
        title="Walk through how to build a pipeline"
        icon={IconTutorial}
        onClick={onTutorial}
      />
      <RailDivider />
      <ThemeCycleButton
        testId="pipeline-editor-theme"
        style={railButtonStyle(false)}
        iconOnly
        iconSize={18}
      />
    </div>
  );
}
