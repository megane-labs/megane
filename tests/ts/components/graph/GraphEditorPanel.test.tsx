/** The shared graph-editor panel: its width drag, its rail slot, and the graph / pane split. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  GRAPH_PANEL_DEFAULT_WIDTH,
  GRAPH_PANEL_MAX_WIDTH,
  GRAPH_PANEL_MIN_WIDTH,
  GraphEditorPanel,
  SplitSeparator,
  useSplitFraction,
} from "@/components/graph/GraphEditorPanel";

function panel(onWidthChange = vi.fn()) {
  const utils = render(
    <GraphEditorPanel
      title="Flow"
      subtitle="2 blocks"
      collapsed={false}
      onToggleCollapse={vi.fn()}
      onWidthChange={onWidthChange}
      testId="graph-row"
      rail={<div data-testid="rail" />}
      extra={<input data-testid="extra" />}
    >
      <div data-testid="editor" />
    </GraphEditorPanel>,
  );
  return { ...utils, onWidthChange };
}

describe("GraphEditorPanel", () => {
  it("puts the rail beside the editor, and reports its width on mount", () => {
    const { onWidthChange } = panel();
    const row = screen.getByTestId("graph-row");
    expect(row.firstElementChild).toBe(screen.getByTestId("rail"));
    expect(row.contains(screen.getByTestId("editor"))).toBe(true);
    expect(screen.getByTestId("extra")).toBeTruthy();
    expect(onWidthChange).toHaveBeenCalledWith(GRAPH_PANEL_DEFAULT_WIDTH);
  });

  it("resizes from its left edge within its bounds", () => {
    const { container, onWidthChange } = panel();
    const handle = [...container.querySelectorAll("div")].find(
      (d) => d.style.cursor === "col-resize",
    )!;
    fireEvent.mouseEnter(handle);
    expect(handle.style.background).not.toBe("transparent");
    fireEvent.mouseLeave(handle);
    expect(handle.style.background).toBe("transparent");

    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 450 });
    expect(onWidthChange).toHaveBeenLastCalledWith(GRAPH_PANEL_DEFAULT_WIDTH + 50);
    fireEvent.mouseMove(document, { clientX: -1000 });
    expect(onWidthChange).toHaveBeenLastCalledWith(GRAPH_PANEL_MAX_WIDTH);
    fireEvent.mouseMove(document, { clientX: 5000 });
    expect(onWidthChange).toHaveBeenLastCalledWith(GRAPH_PANEL_MIN_WIDTH);
    fireEvent.mouseUp(document);
    const calls = onWidthChange.mock.calls.length;
    fireEvent.mouseMove(document, { clientX: 0 });
    expect(onWidthChange.mock.calls.length).toBe(calls);
  });
});

function Split() {
  const [fraction, onMouseDown] = useSplitFraction(0.3);
  return (
    <div data-testid="column">
      <div data-testid="fraction">{fraction}</div>
      <SplitSeparator onMouseDown={onMouseDown} />
    </div>
  );
}

describe("useSplitFraction / SplitSeparator", () => {
  it("drags the pane's share of the column, within 15–70 %", () => {
    render(<Split />);
    const column = screen.getByTestId("column");
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const separator = screen.getByRole("separator");
    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(document, { clientY: 600 });
    expect(screen.getByTestId("fraction").textContent).toBe("0.4");
    fireEvent.mouseMove(document, { clientY: 0 });
    expect(screen.getByTestId("fraction").textContent).toBe("0.7");
    fireEvent.mouseMove(document, { clientY: 1000 });
    expect(screen.getByTestId("fraction").textContent).toBe("0.15");
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientY: 600 });
    expect(screen.getByTestId("fraction").textContent).toBe("0.15");
  });

  it("ignores a column with no height", () => {
    render(<Split />);
    fireEvent.mouseDown(screen.getByRole("separator"));
    fireEvent.mouseMove(document, { clientY: 600 });
    expect(screen.getByTestId("fraction").textContent).toBe("0.3");
  });
});
