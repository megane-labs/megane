/** The top bar's dropdown menu. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Menu } from "@/builder/Menu";

afterEach(cleanup);

function items(onSelect = vi.fn(), disabled = false) {
  return [
    { label: "First", testId: "menu-first", onSelect },
    { label: "Second", testId: "menu-second", onSelect, disabled },
  ];
}

describe("Menu", () => {
  it("opens, runs an item and closes", () => {
    const onSelect = vi.fn();
    render(<Menu testId="save" label="Save" items={items(onSelect)} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByTestId("save"));
    expect(screen.getByTestId("save").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("menu-first"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores a disabled item and a disabled trigger", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Menu testId="save" label="Save" items={items(onSelect, true)} />);
    fireEvent.click(screen.getByTestId("save"));
    fireEvent.click(screen.getByTestId("menu-second"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    rerender(<Menu testId="save" label="Save" items={items(onSelect)} disabled />);
    expect((screen.getByTestId("save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes on Escape and on a click outside", () => {
    render(<Menu testId="save" label="Save" items={items()} />);
    fireEvent.click(screen.getByTestId("save"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByTestId("save"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    // A pointer down inside the menu leaves it open.
    fireEvent.click(screen.getByTestId("save"));
    fireEvent.pointerDown(screen.getByTestId("menu-first"));
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("draws separators and captions, which run nothing", () => {
    const onSelect = vi.fn();
    render(
      <Menu
        testId="tools"
        label="Tools"
        items={[
          { caption: "Server", testId: "menu-caption" },
          { label: "Run", testId: "menu-run", onSelect },
          { separator: true },
          { label: "Settings", testId: "menu-settings", onSelect },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("tools"));
    expect(screen.getByTestId("menu-caption").textContent).toBe("Server");
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Run", "Settings"]);
    fireEvent.click(screen.getByTestId("menu-caption"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("menu-settings"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("places the list under its trigger, inside the window", () => {
    render(<Menu testId="save" label="Save" items={items()} />);
    const trigger = screen.getByTestId("save");
    const rect = (left: number) =>
      ({ left, bottom: 40, top: 20, right: left + 60, width: 60, height: 20 }) as DOMRect;
    const spy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(100));
    fireEvent.click(trigger);
    // Portalled out of the (clipping) panel into <body>.
    const menu = screen.getByTestId("save-menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("44px");
    expect(menu.style.visibility).toBe("visible");
    // A trigger at the right edge pulls the list back inside the window.
    fireEvent.click(trigger);
    spy.mockReturnValue(rect(window.innerWidth - 10));
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 200 });
    try {
      fireEvent.click(trigger);
      expect(screen.getByTestId("save-menu").style.left).toBe(`${window.innerWidth - 208}px`);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", original);
    }
  });

  it("wears a given tint on its trigger and dims it when disabled", () => {
    render(
      <Menu
        testId="tools"
        label="Tools"
        items={items()}
        disabled
        triggerStyle={{ color: "rgb(245, 158, 11)" }}
      />,
    );
    const trigger = screen.getByTestId("tools");
    expect(trigger.style.color).toBe("rgb(245, 158, 11)");
    expect(trigger.style.opacity).toBe("0.45");
  });
});
