/** The operations rail left of the view: File, Structure, Tools, Undo / Redo, theme. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OperationsRail } from "@/builder/OperationsRail";
import { useThemeStore } from "@/stores/useThemeStore";

afterEach(cleanup);

function renderRail(hasDocument = true) {
  const run = vi.fn();
  const menu = (id: string) => [{ label: id, testId: `${id}-item`, onSelect: () => run(id) }];
  const undo = vi.fn();
  const redo = vi.fn();
  render(
    <OperationsRail
      fileItems={menu("file")}
      structureItems={menu("structure")}
      toolsItems={menu("tools")}
      hasDocument={hasDocument}
      canUndo={hasDocument}
      canRedo={false}
      onUndo={undo}
      onRedo={redo}
      mod="Ctrl"
    />,
  );
  return Object.assign(run, { undo, redo });
}

describe("OperationsRail", () => {
  it("offers every action as an icon button with a name", () => {
    renderRail();
    const rail = screen.getByTestId("builder-operations-rail");
    const buttons = [...rail.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "File",
      "Structure",
      "Tools",
      "Undo",
      "Redo",
      "Switch theme, current: Auto",
    ]);
    expect(screen.getByTestId("builder-file").title).toContain("Ctrl+O");
    // Icons only: no caret, and the name is in the tooltip.
    expect(buttons[2].textContent).not.toContain("▼");
    expect(buttons[2].title).toContain("Tools");
    // The library is the Place tool's gallery, not a menu here as well.
    expect(screen.queryByTestId("builder-insert")).toBeNull();
  });

  it("opens each menu to the right of its button, headed by its name", () => {
    const run = renderRail();
    const trigger = screen.getByTestId("builder-tools");
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
    const menu = screen.getByTestId("builder-tools-menu");
    expect(menu.style.left).toBe("58px");
    expect(menu.style.top).toBe("300px");
    expect(screen.getByTestId("builder-tools-heading").textContent).toBe("Tools");
    // The open menu's button is highlighted like the active tool.
    expect(trigger.style.background).not.toBe(closedBackground);
    fireEvent.click(screen.getByTestId("tools-item"));
    expect(run).toHaveBeenCalledWith("tools");
    expect(screen.queryByTestId("builder-tools-menu")).toBeNull();
  });

  it("keeps Structure disabled until a structure is open", () => {
    renderRail(false);
    expect((screen.getByTestId("builder-structure") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("builder-tools") as HTMLButtonElement).disabled).toBe(false);
  });

  it("undoes and redoes only when there is something to", () => {
    const run = renderRail(true);
    const undo = screen.getByTestId("builder-topbar-undo") as HTMLButtonElement;
    const redo = screen.getByTestId("builder-topbar-redo") as HTMLButtonElement;
    expect(undo.title).toBe("Undo (Ctrl+Z)");
    fireEvent.click(undo);
    expect(run.undo).toHaveBeenCalledTimes(1);
    expect(redo.disabled).toBe(true);
    expect(redo.style.opacity).toBe("0.45");
  });

  it("cycles the theme from its icon", () => {
    useThemeStore.getState().setTheme("light");
    renderRail();
    const theme = screen.getByTestId("builder-theme");
    expect(theme.textContent).toBe("");
    fireEvent.click(theme);
    expect(useThemeStore.getState().theme).toBe("dark");
    useThemeStore.getState().setTheme("system");
  });
});
