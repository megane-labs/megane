import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/pipeline/templateAssets", () => ({ loadTemplateData: vi.fn() }));

import { loadTemplateData, type TemplateDataLoader } from "@/pipeline/templateAssets";
import { TEMPLATE_FIXTURE_URLS } from "@/pipeline/templateFixtures";
import { usePipelineStore } from "@/pipeline/store";
import { useTemplateData } from "@/hooks/useTemplateData";

const loadMock = vi.mocked(loadTemplateData);

function makeLoader(): TemplateDataLoader {
  return { loadText: vi.fn(), loadXtc: vi.fn() };
}

/** A promise the test settles by hand, to observe the hook mid-load. */
function deferred() {
  let resolve!: (v: boolean) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pending = () => usePipelineStore.getState().pendingTemplateId;

describe("useTemplateData", () => {
  beforeEach(() => {
    loadMock.mockReset();
    usePipelineStore.setState({ pendingTemplateId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing until a template is applied", () => {
    renderHook(() => useTemplateData(makeLoader()));
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("loads the applied template's files through the host loader, then clears it", async () => {
    const load = deferred();
    loadMock.mockReturnValue(load.promise);
    const loader = makeLoader();
    const onApply = vi.fn();
    renderHook(() => useTemplateData(loader, onApply));

    act(() => usePipelineStore.setState({ pendingTemplateId: "solid" }));

    expect(onApply).toHaveBeenCalledWith("solid");
    expect(loadMock).toHaveBeenCalledTimes(1);
    const [id, urls, getState, passedLoader] = loadMock.mock.calls[0];
    expect(id).toBe("solid");
    expect(urls).toBe(TEMPLATE_FIXTURE_URLS);
    expect(getState()).toBe(usePipelineStore.getState());
    expect(passedLoader).toBe(loader);
    // Still pending while the files load.
    expect(pending()).toBe("solid");

    await act(async () => load.resolve(true));
    expect(pending()).toBeNull();
  });

  it("uses the loader from the latest render", () => {
    loadMock.mockResolvedValue(true);
    const first = makeLoader();
    const second = makeLoader();
    const { rerender } = renderHook(({ loader }) => useTemplateData(loader), {
      initialProps: { loader: first },
    });
    rerender({ loader: second });

    act(() => usePipelineStore.setState({ pendingTemplateId: "molecule" }));

    expect(loadMock.mock.calls[0][3]).toBe(second);
  });

  it("reports a failed load and clears it so the same template can be retried", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    loadMock.mockRejectedValue(new Error("HTTP 404"));
    renderHook(() => useTemplateData(makeLoader()));

    act(() => usePipelineStore.setState({ pendingTemplateId: "protein" }));

    await waitFor(() => expect(pending()).toBeNull());
    expect(error).toHaveBeenCalledWith(
      'Failed to load the "protein" template\'s files:',
      expect.any(Error),
    );
  });

  it("leaves a newer template pending when an older load finishes", async () => {
    const older = deferred();
    loadMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(new Promise(() => {}));
    renderHook(() => useTemplateData(makeLoader()));

    act(() => usePipelineStore.setState({ pendingTemplateId: "solid" }));
    act(() => usePipelineStore.setState({ pendingTemplateId: "esp" }));
    await act(async () => older.resolve(true));

    expect(loadMock.mock.calls.map((c) => c[0])).toEqual(["solid", "esp"]);
    expect(pending()).toBe("esp");
  });
});
