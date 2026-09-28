/** Escape / click-outside dismissal shared by popovers, menus, forms and modals. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { useRef } from "react";
import { useDismiss, dismissLayerCount } from "@/hooks/useDismiss";

afterEach(cleanup);

function Layer({
  onDismiss,
  enabled,
  outside = false,
  testId,
}: {
  onDismiss: () => void;
  enabled?: boolean;
  outside?: boolean;
  testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss({ onDismiss, enabled, inside: outside ? [ref] : undefined });
  return <div ref={ref} data-testid={testId} />;
}

function pressEscape() {
  const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  window.dispatchEvent(ev);
  return ev;
}

describe("useDismiss", () => {
  it("hands Escape to the topmost layer only and marks it handled", () => {
    const form = vi.fn();
    const menu = vi.fn();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    const { rerender } = render(
      <>
        <Layer testId="form" onDismiss={form} />
      </>,
    );
    rerender(
      <>
        <Layer testId="form" onDismiss={form} />
        <Layer testId="menu" onDismiss={menu} />
      </>,
    );
    const ev = pressEscape();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(form).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    // Stopped in the capture phase: the bubble-phase shortcut listeners never see it.
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener("keydown", later);
  });

  it("passes Escape down once the top layer closes, and lets it through with none open", () => {
    const form = vi.fn();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    const { rerender } = render(
      <>
        <Layer testId="form" onDismiss={form} />
        <Layer testId="menu" onDismiss={vi.fn()} />
      </>,
    );
    rerender(
      <>
        <Layer testId="form" onDismiss={form} />
        <Layer testId="menu" onDismiss={vi.fn()} enabled={false} />
      </>,
    );
    pressEscape();
    expect(form).toHaveBeenCalledTimes(1);
    cleanup();
    expect(dismissLayerCount()).toBe(0);
    const ev = pressEscape();
    expect(ev.defaultPrevented).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", later);
  });

  it("ignores other keys", () => {
    const onDismiss = vi.fn();
    render(<Layer testId="a" onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: "a" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("uses the latest callback without re-stacking on re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Layer testId="a" onDismiss={first} />);
    rerender(<Layer testId="a" onDismiss={second} />);
    expect(dismissLayerCount()).toBe(1);
    pressEscape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("closes on a pointerdown outside `inside`, not inside it", () => {
    const onDismiss = vi.fn();
    render(<Layer testId="pop" outside onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId("pop"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores outside clicks without `inside`, and everything while disabled", () => {
    const form = vi.fn();
    const closed = vi.fn();
    render(
      <>
        <Layer testId="form" onDismiss={form} />
        <Layer testId="closed" outside enabled={false} onDismiss={closed} />
      </>,
    );
    fireEvent.pointerDown(document.body);
    expect(form).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    pressEscape();
    expect(form).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });
});
