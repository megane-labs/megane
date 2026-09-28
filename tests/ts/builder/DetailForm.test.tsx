/** The card a form opens in the Builder's Details panel. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DetailForm } from "@/builder/DetailForm";

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
