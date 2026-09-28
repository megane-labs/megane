/** The operations rail left of the view: Structure, Insert and Tools menus. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OperationsRail } from "@/builder/OperationsRail";

afterEach(cleanup);

function renderRail(hasDocument = true) {
  const run = vi.fn();
  const menu = (id: string) => [{ label: id, testId: `${id}-item`, onSelect: () => run(id) }];
  render(
    <OperationsRail
      structureItems={menu("structure")}
      insertItems={menu("insert")}
      toolsItems={menu("tools")}
      hasDocument={hasDocument}
    />,
  );
  return run;
}

describe("OperationsRail", () => {
  it("offers Structure, Insert and Tools as icon buttons with names", () => {
    renderRail();
    const rail = screen.getByTestId("builder-operations-rail");
    const buttons = [...rail.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Structure",
      "Insert",
      "Tools",
    ]);
    // Icons only: no caret, and the name is in the tooltip.
    expect(buttons[1].textContent).not.toContain("▼");
    expect(buttons[1].title).toContain("Insert");
  });

  it("opens each menu to the right of its button, headed by its name", () => {
    const run = renderRail();
    const trigger = screen.getByTestId("builder-insert");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 50,
      top: 300,
      bottom: 338,
      width: 38,
      height: 38,
    } as DOMRect);
    const closedBackground = trigger.style.background;
    fireEvent.click(trigger);
    const menu = screen.getByTestId("builder-insert-menu");
    expect(menu.style.left).toBe("58px");
    expect(menu.style.top).toBe("300px");
    expect(screen.getByTestId("builder-insert-heading").textContent).toBe("Insert");
    // The open menu's button is highlighted like the active tool.
    expect(trigger.style.background).not.toBe(closedBackground);
    fireEvent.click(screen.getByTestId("insert-item"));
    expect(run).toHaveBeenCalledWith("insert");
    expect(screen.queryByTestId("builder-insert-menu")).toBeNull();
  });

  it("keeps Structure disabled until a structure is open", () => {
    renderRail(false);
    expect((screen.getByTestId("builder-structure") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("builder-tools") as HTMLButtonElement).disabled).toBe(false);
  });
});
