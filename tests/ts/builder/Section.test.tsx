/**
 * The collapsible sidebar section and the storage behind its open state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "./util";
import { Section, SECTIONS_STORAGE_KEY, useSectionOpen } from "@/builder/Section";
import { renderHook, act } from "./util";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Section", () => {
  it("shows its children when open and hides them when collapsed", () => {
    render(
      <Section id="library" title="Library" summary="2 molecules">
        <div data-testid="body">contents</div>
      </Section>,
    );
    expect(screen.getByTestId("body")).toBeTruthy();
    expect(screen.getByTestId("builder-section-library-summary").textContent).toBe("2 molecules");
    expect(screen.getByTestId("builder-section-library-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.click(screen.getByTestId("builder-section-library-toggle"));
    expect(screen.getByTestId("body")).not.toBeVisible();
    // The summary stays visible while collapsed.
    expect(screen.getByTestId("builder-section-library-summary")).toBeTruthy();
  });

  it("starts closed when asked, and remembers a toggle across mounts", async () => {
    const { unmount } = render(
      <Section id="history" title="History" defaultOpen={false}>
        <div data-testid="body">contents</div>
      </Section>,
    );
    expect(screen.getByTestId("body")).not.toBeVisible();
    fireEvent.click(screen.getByTestId("builder-section-history-toggle"));
    // Opening animates, so the body becomes visible on the next frame.
    await waitFor(() => expect(screen.getByTestId("body")).toBeVisible());
    expect(JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY)!)).toEqual({ history: true });
    unmount();
    // A later mount follows the stored choice, not the default.
    render(
      <Section id="history" title="History" defaultOpen={false}>
        <div data-testid="body">contents</div>
      </Section>,
    );
    await waitFor(() => expect(screen.getByTestId("body")).toBeVisible());
  });

  it("renders without a summary", () => {
    render(
      <Section id="tools" title="Tools">
        <div data-testid="body">contents</div>
      </Section>,
    );
    expect(screen.queryByTestId("builder-section-tools-summary")).toBeNull();
  });
});

describe("useSectionOpen", () => {
  it("keeps sections apart and survives unreadable storage", () => {
    localStorage.setItem(SECTIONS_STORAGE_KEY, "not json");
    const { result } = renderHook(() => useSectionOpen("crystal", true));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    const other = renderHook(() => useSectionOpen("library", true));
    expect(other.result.current[0]).toBe(true);
    expect(JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY)!)).toEqual({ crystal: false });
  });

  it("drops stored values that are not booleans, and works with no storage at all", () => {
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify({ crystal: "yes", library: false }));
    expect(renderHook(() => useSectionOpen("crystal", true)).result.current[0]).toBe(true);
    expect(renderHook(() => useSectionOpen("library", true)).result.current[0]).toBe(false);
    const { result } = renderHook(() => useSectionOpen("crystal", true, null));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
  });
});
