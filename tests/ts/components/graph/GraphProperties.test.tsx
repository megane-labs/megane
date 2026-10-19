/** The shared properties pane pieces and node card, on their own. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Handle: (props: { id?: string; type?: string; children?: ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": `handle-${props.type}-${props.id}` },
        props.children,
      ),
    Position: { Top: "top", Bottom: "bottom" },
  };
});

import {
  NodeMessages,
  PropertiesEmpty,
  PropertiesHeader,
  PropertiesPaneView,
} from "@/components/graph/GraphProperties";
import { NodeCardView } from "@/components/graph/NodeCardView";

describe("PropertiesHeader", () => {
  it("shows a switch only with onToggle, and a remove button only with onRemove", () => {
    const { rerender } = render(
      <PropertiesHeader icon={null} color="#123456" title="Molecule" summary="CCO" />,
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByLabelText("Remove node")).toBeNull();
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    rerender(
      <PropertiesHeader
        icon={null}
        color="#123456"
        title="Filter"
        summary="all"
        enabled={false}
        onToggle={onToggle}
        onRemove={onRemove}
        removeTestId="remove"
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalled();
    const remove = screen.getByTestId("remove");
    fireEvent.mouseEnter(remove);
    expect(remove.style.color).toBe("var(--megane-danger)");
    fireEvent.mouseLeave(remove);
    expect(remove.style.color).toBe("var(--megane-text-muted)");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalled();
  });

  it("refuses removal while asked to", () => {
    const onRemove = vi.fn();
    render(
      <PropertiesHeader
        icon={null}
        color="#000"
        title="Tool"
        summary=""
        onRemove={onRemove}
        removeDisabled
        removeTestId="remove"
      />,
    );
    const remove = screen.getByTestId("remove") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.style.opacity).toBe("0.4");
  });
});

describe("NodeMessages / PropertiesEmpty / PropertiesPaneView", () => {
  it("lists errors as alerts and warnings as statuses", () => {
    render(
      <NodeMessages
        messages={[
          { severity: "error", message: "bad" },
          { severity: "warning", message: "meh" },
        ]}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("bad");
    expect(screen.getByRole("status").textContent).toContain("meh");
  });

  it("shows the hint with nothing selected, the head and a faded body with something", () => {
    const { rerender } = render(
      <PropertiesPaneView
        height="40%"
        bodyVisible={false}
        head={<div data-testid="head" />}
        empty={<PropertiesEmpty text="Pick one" />}
      >
        <div />
      </PropertiesPaneView>,
    );
    expect(screen.getByTestId("pipeline-properties-empty").textContent).toBe("Pick one");
    expect(screen.queryByTestId("head")).toBeNull();
    expect(screen.getByTestId("pipeline-properties-body").style.display).toBe("none");
    rerender(
      <PropertiesPaneView
        height="40%"
        bodyVisible
        bodyFaded
        scrollKey="a"
        head={<div data-testid="head" />}
        empty={<PropertiesEmpty text="Pick one" />}
      >
        <div />
      </PropertiesPaneView>,
    );
    expect(screen.getByTestId("head")).toBeTruthy();
    const body = screen.getByTestId("pipeline-properties-body");
    expect(body.style.opacity).toBe("0.55");
    body.scrollTop = 120;
    rerender(
      <PropertiesPaneView height="40%" bodyVisible scrollKey="b">
        <div />
      </PropertiesPaneView>,
    );
    expect(screen.getByTestId("pipeline-properties-body").scrollTop).toBe(0);
  });
});

describe("NodeCardView", () => {
  it("draws a switched-off node faded with its Off mark, ports, and a status dot", () => {
    render(
      <NodeCardView
        testId="card"
        nodeId="n1"
        title="Filter"
        summary="element O"
        monoSummary
        summaryTestId="summary"
        icon={null}
        color="#10b981"
        inputs={[{ name: "in", label: "Particle", color: "#3b82f6", disabled: true }]}
        outputs={[{ name: "out", label: "Particle", color: "#3b82f6" }]}
        enabled={false}
        selected={false}
        error
        status={{ color: "red", title: "broken", testId: "dot" }}
        data={{ "data-status": "error" }}
      />,
    );
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-enabled")).toBe("false");
    expect(card.getAttribute("data-status")).toBe("error");
    expect(card.style.opacity).toBe("0.55");
    expect(card.style.border).toContain("dashed");
    expect(card.textContent).toContain("Off");
    expect(screen.getByTestId("summary").style.fontFamily).toContain("monospace");
    expect(screen.getByTestId("dot").getAttribute("title")).toBe("broken");
    expect(screen.getByTestId("handle-target-in")).toBeTruthy();
    expect(screen.getByTestId("handle-source-out")).toBeTruthy();
  });
});
