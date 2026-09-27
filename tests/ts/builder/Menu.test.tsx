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
});
