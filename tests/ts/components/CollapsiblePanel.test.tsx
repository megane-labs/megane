import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";

afterEach(() => {
  cleanup();
});

describe("CollapsiblePanel", () => {
  it("stretches from top to the given bottom offset and puts the stub at the top", () => {
    const { rerender } = render(
      <CollapsiblePanel title="Pipeline" collapsed={false} onToggleCollapse={() => {}} bottom={72}>
        <div />
      </CollapsiblePanel>,
    );
    let root = screen.getByTestId("panel-pipeline");
    expect(root.style.top).toBe("12px");
    expect(root.style.bottom).toBe("72px");
    rerender(
      <CollapsiblePanel title="Pipeline" collapsed={true} onToggleCollapse={() => {}} bottom={72}>
        <div />
      </CollapsiblePanel>,
    );
    root = screen.getByTestId("panel-pipeline");
    expect(root.getAttribute("data-collapsed")).toBe("true");
    expect(root.style.top).toBe("12px");
    expect(root.style.bottom).toBe("");
  });

  it("renders the collapsed toggle button when collapsed", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel title="Pipeline" collapsed={true} onToggleCollapse={onToggle}>
        <div>Hidden body</div>
      </CollapsiblePanel>,
    );

    const root = screen.getByTestId("panel-pipeline");
    expect(root.getAttribute("data-collapsed")).toBe("true");

    const toggle = screen.getByTestId("panel-pipeline-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders the expanded panel with children when not collapsed", () => {
    const onToggle = vi.fn();
    render(
      <CollapsiblePanel title="Pipeline" collapsed={false} onToggleCollapse={onToggle}>
        <div data-testid="panel-body">Visible body</div>
      </CollapsiblePanel>,
    );

    const root = screen.getByTestId("panel-pipeline");
    expect(root.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByTestId("panel-body")).toBeTruthy();

    const toggle = screen.getByTestId("panel-pipeline-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders headerExtra and containerExtra when expanded", () => {
    render(
      <CollapsiblePanel
        title="Appearance"
        collapsed={false}
        onToggleCollapse={() => {}}
        headerExtra={<button data-testid="extra-btn">Extra</button>}
        containerExtra={<div data-testid="container-extra" />}
      >
        body
      </CollapsiblePanel>,
    );

    expect(screen.getByTestId("extra-btn")).toBeTruthy();
    expect(screen.getByTestId("container-extra")).toBeTruthy();
  });

  it("derives a slug-style testid from a multi-word title", () => {
    render(
      <CollapsiblePanel title="Render Settings" collapsed={true} onToggleCollapse={() => {}}>
        body
      </CollapsiblePanel>,
    );
    expect(screen.getByTestId("panel-render-settings")).toBeTruthy();
  });
});
