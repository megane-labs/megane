import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("@/components/Viewport", () => ({ Viewport: vi.fn(() => null) }));
vi.mock("@/components/Timeline", () => ({ Timeline: vi.fn(() => null) }));
vi.mock("@/components/Tooltip", () => ({ Tooltip: vi.fn(() => null) }));
vi.mock("@/parsers/structure", () => ({ parseStructureFile: vi.fn() }));

import { PipelineViewer } from "@/components/PipelineViewer";
import type { SerializedPipeline } from "@/pipeline/types";

describe("PipelineViewer", () => {
  it("executes an empty pipeline and leaves the loading state", async () => {
    const pipeline: SerializedPipeline = { version: 3, nodes: [], edges: [] };
    const { container, queryByText } = render(<PipelineViewer pipeline={pipeline} />);

    expect(queryByText("Loading…")).not.toBeNull();
    await waitFor(() => expect(queryByText("Loading…")).toBeNull());
    // No load node → no snapshot, no error; the viewer chrome still mounts.
    expect(queryByText(/Failed to load/)).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });

  it("makes its root focusable so the Timeline's ←/→ shortcut answers after a click", async () => {
    const pipeline: SerializedPipeline = { version: 3, nodes: [], edges: [] };
    const { container, queryByText } = render(<PipelineViewer pipeline={pipeline} />);
    await waitFor(() => expect(queryByText("Loading…")).toBeNull());
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("tabindex")).toBe("-1");
    root.focus();
    expect(document.activeElement).toBe(root);
  });
});
