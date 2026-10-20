/** The top bar's dropdown menu. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Menu, menuBounds } from "@/builder/Menu";

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

  it("opening to the right stays inside the window at the bottom", () => {
    render(<Menu testId="ops" label="Ops" items={items()} placement="right" caret={false} />);
    const trigger = screen.getByTestId("ops");
    expect(trigger.textContent).toBe("Ops");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 50,
      top: window.innerHeight - 20,
      bottom: window.innerHeight,
      width: 38,
      height: 20,
    } as DOMRect);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 100,
    });
    try {
      fireEvent.click(trigger);
      const menu = screen.getByTestId("ops-menu");
      expect(menu.style.left).toBe("58px");
      expect(menu.style.top).toBe(`${window.innerHeight - 108}px`);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    }
  });

  it("inside a Builder, stays within the Builder, which may end above the window's bottom", () => {
    render(
      <div data-testid="megane-builder">
        <Menu testId="ops" label="Ops" items={items()} placement="right" caret={false} />
      </div>,
    );
    const builder = screen.getByTestId("megane-builder");
    vi.spyOn(builder, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 400,
      top: 100,
      bottom: 300,
      width: 400,
      height: 200,
    } as DOMRect);
    const trigger = screen.getByTestId("ops");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 50,
      top: 280,
      bottom: 300,
      width: 38,
      height: 20,
    } as DOMRect);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 100,
    });
    try {
      fireEvent.click(trigger);
      const menu = screen.getByTestId("ops-menu");
      // Bottom of the Builder (300) − height (100) − edge (8).
      expect(menu.style.top).toBe("192px");
      expect(menu.style.maxHeight).toBe("100px");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    }
  });
});

describe("menuBounds", () => {
  const win = { innerWidth: 1000, innerHeight: 800 };
  const rect = (r: Partial<DOMRect>) =>
    ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...r }) as DOMRect;

  it("is the window outside a Builder", () => {
    const el = document.createElement("button");
    expect(menuBounds(el, win)).toEqual({ left: 0, top: 0, right: 1000, bottom: 800 });
  });

  it("is the Builder's part of the window inside one", () => {
    const builder = document.createElement("div");
    builder.dataset.testid = "megane-builder";
    const el = document.createElement("button");
    builder.appendChild(el);
    vi.spyOn(builder, "getBoundingClientRect").mockReturnValue(
      rect({ left: -50, top: 200, right: 600, bottom: 2000, width: 650, height: 1800 }),
    );
    expect(menuBounds(el, win)).toEqual({ left: 0, top: 200, right: 600, bottom: 800 });
  });

  it("ignores a Builder that is not laid out", () => {
    const builder = document.createElement("div");
    builder.dataset.testid = "megane-builder";
    const el = document.createElement("button");
    builder.appendChild(el);
    expect(menuBounds(el, win)).toEqual({ left: 0, top: 0, right: 1000, bottom: 800 });
  });
});

describe("Menu — keyboard", () => {
  const list = (onSelect = vi.fn()) => [
    { label: "First", testId: "k-first", onSelect },
    { separator: true as const },
    { label: "Off", testId: "k-off", onSelect, disabled: true, title: "Open a structure first" },
    { caption: "More" },
    { label: "Third", testId: "k-third", onSelect },
  ];

  it("is a menu button", () => {
    render(<Menu testId="m" label="File" items={list()} />);
    const trigger = screen.getByTestId("m");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("File");
  });

  it("Enter, Space or ↓ opens it on the first item, ↑ on the last", () => {
    for (const [key, first] of [
      ["Enter", "k-first"],
      [" ", "k-first"],
      ["ArrowDown", "k-first"],
      ["ArrowUp", "k-third"],
    ] as const) {
      const { unmount } = render(<Menu testId="m" label="File" items={list()} />);
      fireEvent.keyDown(screen.getByTestId("m"), { key });
      expect(document.activeElement).toBe(screen.getByTestId(first));
      unmount();
    }
  });

  it("other keys on the trigger, or a disabled trigger, do nothing", () => {
    const { rerender } = render(<Menu testId="m" label="File" items={list()} />);
    fireEvent.keyDown(screen.getByTestId("m"), { key: "a" });
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<Menu testId="m" label="File" items={list()} disabled />);
    fireEvent.keyDown(screen.getByTestId("m"), { key: "ArrowDown" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("arrows, Home and End move between the items that can run", () => {
    render(<Menu testId="m" label="File" items={list()} />);
    fireEvent.keyDown(screen.getByTestId("m"), { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // The disabled item is skipped.
    expect(document.activeElement).toBe(screen.getByTestId("k-third"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("k-first"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("k-third"));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByTestId("k-first"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("k-third"));
    fireEvent.keyDown(menu, { key: "x" });
    expect(document.activeElement).toBe(screen.getByTestId("k-third"));
    // From outside the items, ↓ starts at the top and ↑ at the bottom.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("k-first"));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("k-third"));
  });

  it("a menu with nothing to run ignores the arrows", () => {
    render(
      <Menu testId="m" label="File" items={[{ label: "x", onSelect: vi.fn(), disabled: true }]} />,
    );
    fireEvent.keyDown(screen.getByTestId("m"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(document.body);
  });

  it("↓ on the trigger of a clicked-open menu steps into it", () => {
    render(<Menu testId="m" label="File" items={list()} />);
    const trigger = screen.getByTestId("m");
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(screen.getByTestId("k-first"));
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("k-third"));
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("k-first"));
  });

  it("Escape closes it and gives focus back to the trigger; Tab just closes it", () => {
    render(<Menu testId="m" label="File" items={list()} />);
    const trigger = screen.getByTestId("m");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("running an item from the keyboard puts focus back on the trigger", () => {
    const onSelect = vi.fn();
    render(<Menu testId="m" label="File" items={list(onSelect)} />);
    fireEvent.keyDown(screen.getByTestId("m"), { key: "ArrowDown" });
    fireEvent.click(document.activeElement!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId("m"));
  });

  it("a disabled item says why in its title", () => {
    render(<Menu testId="m" label="File" items={list()} />);
    fireEvent.click(screen.getByTestId("m"));
    const off = screen.getByTestId("k-off") as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(off.title).toBe("Open a structure first");
    expect(screen.getByTestId("k-first").getAttribute("aria-disabled")).toBeNull();
  });
});
