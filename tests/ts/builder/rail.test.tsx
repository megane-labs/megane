/** The floating name label `RailLabels` shows beside the Builder's icon-only rails. */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { RailLabels, railButtonName } from "@/builder/rail";

afterEach(cleanup);

function Rails({ scoped = false }: { scoped?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <div data-testid="builder-tool-rail">
        <button data-testid="tool" aria-label="Select (S)">
          <svg data-testid="tool-icon" />
        </button>
        <button data-testid="menu" aria-label="File" aria-expanded="true" />
        <button data-testid="unnamed" />
      </div>
      <div data-rail-labels="">
        <button data-testid="titled" title="Undo — the last edit" />
      </div>
      <button data-testid="plain" aria-label="Not on a rail" />
      <RailLabels scope={scoped ? ref : undefined} />
    </div>
  );
}

const label = () => screen.queryByTestId("builder-rail-label");

describe("railButtonName", () => {
  it("is the accessible label, else the title's first part", () => {
    const b = document.createElement("button");
    expect(railButtonName(b)).toBe("");
    b.title = "Undo — the last edit";
    expect(railButtonName(b)).toBe("Undo");
    b.setAttribute("aria-label", "Undo (Ctrl+Z)");
    expect(railButtonName(b)).toBe("Undo (Ctrl+Z)");
  });
});

describe("RailLabels", () => {
  it("names the rail button under the pointer, at once, beside it", () => {
    render(<Rails />);
    expect(label()).toBeNull();
    const tool = screen.getByTestId("tool");
    tool.getBoundingClientRect = () =>
      ({ left: 6, top: 100, right: 44, bottom: 138, width: 38, height: 38 }) as DOMRect;
    fireEvent.pointerOver(screen.getByTestId("tool-icon"));
    expect(label()!.textContent).toBe("Select (S)");
    expect(label()!.getAttribute("aria-hidden")).toBe("true");
    expect(label()!.style.left).toBe("52px");
    expect(label()!.style.top).toBe("119px");
    // Moving within the button keeps it; leaving hides it.
    tool.dispatchEvent(
      new MouseEvent("pointerout", {
        bubbles: true,
        relatedTarget: screen.getByTestId("tool-icon"),
      }),
    );
    expect(label()).not.toBeNull();
    fireEvent.pointerOut(tool);
    expect(label()).toBeNull();
  });

  it("names the focused button too, and hides on a click or Escape", () => {
    render(<Rails />);
    fireEvent.focusIn(screen.getByTestId("titled"));
    expect(label()!.textContent).toBe("Undo");
    fireEvent.click(screen.getByTestId("titled"));
    expect(label()).toBeNull();
    fireEvent.focusIn(screen.getByTestId("tool"));
    fireEvent.keyDown(screen.getByTestId("tool"), { key: "a" });
    expect(label()).not.toBeNull();
    fireEvent.keyDown(screen.getByTestId("tool"), { key: "Escape" });
    expect(label()).toBeNull();
    fireEvent.focusIn(screen.getByTestId("tool"));
    fireEvent.focusOut(screen.getByTestId("tool"));
    expect(label()).toBeNull();
  });

  it("stays out of the way of an open menu, a nameless button and other buttons", () => {
    render(<Rails />);
    fireEvent.pointerOver(screen.getByTestId("tool"));
    fireEvent.pointerOver(screen.getByTestId("menu"));
    expect(label()).toBeNull();
    fireEvent.pointerOver(screen.getByTestId("unnamed"));
    expect(label()).toBeNull();
    fireEvent.pointerOver(screen.getByTestId("plain"));
    fireEvent.pointerOut(screen.getByTestId("plain"));
    expect(label()).toBeNull();
  });

  it("listens only inside its scope when given one", () => {
    render(<Rails scoped />);
    fireEvent.pointerOver(screen.getByTestId("tool"));
    expect(label()!.textContent).toBe("Select (S)");
    cleanup();
    // An outside rail is not named by a scoped instance.
    const outside = document.createElement("div");
    outside.setAttribute("data-rail-labels", "");
    const b = document.createElement("button");
    b.setAttribute("aria-label", "Far");
    outside.append(b);
    document.body.append(outside);
    render(<Rails scoped />);
    fireEvent.pointerOver(b);
    expect(label()).toBeNull();
    outside.remove();
  });

  it("does nothing with a scope that is not mounted", () => {
    render(<RailLabels scope={{ current: null }} />);
    expect(label()).toBeNull();
  });
});
