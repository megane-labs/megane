/** The stored open / closed state of the Builder's panels. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { SECTIONS_STORAGE_KEY, useSectionOpen } from "@/builder/panelState";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

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

  it("a later mount follows the stored choice, not the default", () => {
    const first = renderHook(() => useSectionOpen("history", false));
    act(() => first.result.current[1]());
    first.unmount();
    expect(renderHook(() => useSectionOpen("history", false)).result.current[0]).toBe(true);
  });

  it("reveal opens a closed panel and remembers it", () => {
    const { result } = renderHook(() => useSectionOpen("details", false));
    act(() => result.current[2]());
    expect(result.current[0]).toBe(true);
    expect(JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY)!)).toEqual({ details: true });
  });
});
