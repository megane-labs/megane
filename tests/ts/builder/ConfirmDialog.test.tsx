import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmHost } from "@/builder/ConfirmDialog";
import { BuilderProvider, createBuilderStores } from "@/builder/BuilderStores";

function mount() {
  const stores = createBuilderStores();
  render(
    <BuilderProvider stores={stores}>
      <ConfirmHost />
    </BuilderProvider>,
  );
  return stores.builder;
}

describe("ConfirmHost", () => {
  it("draws nothing without a question", () => {
    mount();
    expect(screen.queryByTestId("builder-confirm")).toBeNull();
  });

  it("asks, focuses the go-ahead button and answers yes", async () => {
    const api = mount();
    let answer!: Promise<boolean>;
    act(() => {
      answer = api.getState().requestConfirm({
        title: "Discard unsaved edits?",
        message: "Open b.pdb replaces it.",
        confirmLabel: "Discard edits",
        danger: true,
      });
    });
    expect(screen.getByTestId("builder-confirm").textContent).toContain("Open b.pdb");
    expect(document.activeElement).toBe(screen.getByTestId("builder-confirm-ok"));
    act(() => fireEvent.click(screen.getByTestId("builder-confirm-ok")));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByTestId("builder-confirm")).toBeNull();
  });

  it("answers no on Cancel and on Escape", async () => {
    const api = mount();
    let answer!: Promise<boolean>;
    act(() => {
      answer = api.getState().requestConfirm({ title: "T", message: "m", confirmLabel: "Go" });
    });
    act(() => fireEvent.click(screen.getByTestId("builder-confirm-cancel")));
    await expect(answer).resolves.toBe(false);

    act(() => {
      answer = api.getState().requestConfirm({ title: "T", message: "m", confirmLabel: "Go" });
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await expect(answer).resolves.toBe(false);
  });
});
