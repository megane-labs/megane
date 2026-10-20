import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PipelineRail, ADD_NODE_GROUPS, type PipelineRailProps } from "@/components/PipelineRail";
import { PIPELINE_TEMPLATES } from "@/pipeline/templates";
import { NODE_TYPE_LABELS } from "@/pipeline/types";

function renderRail(overrides: Partial<PipelineRailProps> = {}) {
  const props: PipelineRailProps = {
    mode: "editor",
    onModeChange: vi.fn(),
    onAddNode: vi.fn(),
    onApplyTemplate: vi.fn(),
    onAutoLayout: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    onShare: vi.fn(),
    onRender: vi.fn(),
    onGuide: vi.fn(),
    onTutorial: vi.fn(),
    ...overrides,
  };
  render(<PipelineRail {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("PipelineRail", () => {
  it("is a vertical toolbar of icon buttons, each with an accessible name", () => {
    renderRail();
    const rail = screen.getByTestId("pipeline-rail");
    expect(rail.getAttribute("role")).toBe("toolbar");
    expect(rail.getAttribute("aria-orientation")).toBe("vertical");
    for (const button of rail.querySelectorAll("button")) {
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("marks the current mode's tab selected and switches mode on click", () => {
    const props = renderRail({ mode: "inspector" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(tabs[1].getAttribute("aria-controls")).toBe("pipeline-tabpanel-inspector");
    expect(tabs[1].id).toBe("pipeline-tab-inspector");
    // The assistant is docked in the Editor tab, not a tab of its own.
    expect(screen.queryByTestId("pipeline-editor-tab-chat")).toBeNull();

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-editor"));
    expect(props.onModeChange).toHaveBeenCalledWith("editor");
  });

  it("lists every Add Node group under a caption and adds the picked type", () => {
    const props = renderRail();
    fireEvent.click(screen.getByTitle("Add Node"));
    const menu = screen.getByTestId("pipeline-editor-add-menu");
    for (const group of ADD_NODE_GROUPS) {
      expect(menu.textContent).toContain(group.label);
      for (const type of group.types) {
        expect(screen.getByTestId(`pipeline-add-${type}`)).toHaveTextContent(
          NODE_TYPE_LABELS[type],
        );
      }
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "Replicate" }));
    expect(props.onAddNode).toHaveBeenCalledWith("replicate");
    // Picking an item closes the menu.
    expect(screen.queryByTestId("pipeline-editor-add-menu")).toBeNull();
  });

  it("offers every node type except the viewport in the Add Node menu", () => {
    const listed = new Set(ADD_NODE_GROUPS.flatMap((g) => g.types));
    const missing = Object.keys(NODE_TYPE_LABELS).filter(
      (type) => type !== "viewport" && !listed.has(type as keyof typeof NODE_TYPE_LABELS),
    );
    expect(missing).toEqual([]);
    expect(listed.has("surface_mesh")).toBe(true);
  });

  it("offers every template with its description", () => {
    const props = renderRail();
    fireEvent.click(screen.getByTestId("pipeline-editor-templates"));
    for (const t of PIPELINE_TEMPLATES) {
      const item = screen.getByTestId(`pipeline-template-${t.id}`);
      expect(item).toHaveTextContent(t.label);
      expect(item).toHaveTextContent(t.description);
    }
    fireEvent.click(screen.getByTestId(`pipeline-template-${PIPELINE_TEMPLATES[0].id}`));
    expect(props.onApplyTemplate).toHaveBeenCalledWith(PIPELINE_TEMPLATES[0].id);
  });

  it("runs import, export and share from the File menu", () => {
    const props = renderRail();
    for (const [id, handler] of [
      ["pipeline-editor-import", props.onImport],
      ["pipeline-editor-export", props.onExport],
      ["pipeline-editor-share", props.onShare],
    ] as const) {
      fireEvent.click(screen.getByTestId("pipeline-editor-file"));
      fireEvent.click(screen.getByTestId(id));
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it("wires the plain buttons to their actions", () => {
    const props = renderRail();
    fireEvent.click(screen.getByTestId("pipeline-editor-layout"));
    fireEvent.click(screen.getByTestId("pipeline-editor-render"));
    fireEvent.click(screen.getByTestId("pipeline-editor-guide"));
    fireEvent.click(screen.getByTestId("pipeline-editor-tutorial"));
    expect(props.onAutoLayout).toHaveBeenCalledTimes(1);
    expect(props.onRender).toHaveBeenCalledTimes(1);
    expect(props.onGuide).toHaveBeenCalledTimes(1);
    expect(props.onTutorial).toHaveBeenCalledTimes(1);
  });
});
