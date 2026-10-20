/** The card a form opens in the Builder's Details panel. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DetailForm, firstFormControl } from "@/builder/DetailForm";

afterEach(cleanup);

describe("DetailForm", () => {
  it("closes from its Close button and on Escape", () => {
    const onClose = vi.fn();
    render(
      <DetailForm testId="form" title="Tool server" onClose={onClose} closeTestId="form-close">
        body
      </DetailForm>,
    );
    expect(screen.getByRole("dialog", { name: "Tool server" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("form-close"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("refuses to close while closeDisabled, but still owns Escape", () => {
    const onClose = vi.fn();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    render(
      <DetailForm
        testId="form"
        title="Run"
        onClose={onClose}
        closeTestId="form-close"
        closeDisabled
      >
        body
      </DetailForm>,
    );
    expect((screen.getByTestId("form-close") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener("keydown", later);
  });

  it("shows a breadcrumb title without a Close button, and passes data attributes", () => {
    render(
      <DetailForm
        testId="form"
        title="Cut slab"
        breadcrumb="Structure ›"
        onClose={vi.fn()}
        data={{ "data-kind": "slab" }}
      >
        body
      </DetailForm>,
    );
    const card = screen.getByTestId("form");
    expect(card.getAttribute("data-kind")).toBe("slab");
    expect(card.textContent).toContain("Structure ›");
    expect(card.querySelector("button")).toBeNull();
  });
});

describe("DetailForm — focus", () => {
  it("moves focus to the first field when it opens", () => {
    render(
      <DetailForm testId="form" title="New" onClose={vi.fn()} closeTestId="form-close">
        <input data-testid="hidden" type="hidden" />
        <input data-testid="off" disabled />
        <input data-testid="edge" />
        <input data-testid="other" />
      </DetailForm>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("edge"));
  });

  it("without a field, focuses its first control other than Close", () => {
    render(
      <DetailForm testId="form" title="Run" onClose={vi.fn()} closeTestId="form-close">
        <button data-testid="go">Go</button>
      </DetailForm>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("go"));
  });

  it("leaves focus alone with nothing to focus, and on later renders", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { rerender } = render(
      <DetailForm testId="form" title="Info" onClose={vi.fn()} closeTestId="form-close">
        text
      </DetailForm>,
    );
    expect(document.activeElement).toBe(outside);
    rerender(
      <DetailForm testId="form" title="Info" onClose={vi.fn()} closeTestId="form-close">
        <input data-testid="late" />
      </DetailForm>,
    );
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("keeps focus that a child already took", () => {
    function Auto() {
      return <input data-testid="auto" autoFocus />;
    }
    render(
      <DetailForm testId="form" title="New" onClose={vi.fn()}>
        <input data-testid="first" />
        <Auto />
      </DetailForm>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("auto"));
  });
});

describe("firstFormControl", () => {
  it("prefers fields, then other controls, and never the Close button", () => {
    const card = document.createElement("div");
    card.innerHTML =
      '<button data-testid="x-close">Close</button><a href="#">link</a><select></select>';
    expect(firstFormControl(card, "x-close")!.tagName).toBe("SELECT");
    card.querySelector("select")!.remove();
    expect(firstFormControl(card, "x-close")!.tagName).toBe("A");
    expect(firstFormControl(card)!.tagName).toBe("BUTTON");
    card.querySelector("a")!.remove();
    expect(firstFormControl(card, "x-close")).toBeNull();
  });
});
