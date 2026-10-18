import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  getRemoteFileSource,
  setRemoteFileSource,
  useRemoteFileSource,
  type RemoteFileSource,
} from "@/remote/fileSource";

const native: RemoteFileSource = {
  mode: "native",
  label: "Open from remote...",
  pick: async () => null,
};

describe("remote file source registry", () => {
  afterEach(() => setRemoteFileSource(null));

  it("starts empty and stores what a host registers", () => {
    expect(getRemoteFileSource()).toBeNull();
    setRemoteFileSource(native);
    expect(getRemoteFileSource()).toBe(native);
  });

  it("re-renders hook users when a source is registered later and removed", () => {
    const { result } = renderHook(() => useRemoteFileSource());
    expect(result.current).toBeNull();
    act(() => setRemoteFileSource(native));
    expect(result.current).toBe(native);
    // Registering the same source again is a no-op.
    act(() => setRemoteFileSource(native));
    expect(result.current).toBe(native);
    act(() => setRemoteFileSource(null));
    expect(result.current).toBeNull();
  });
});
