import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RemoteFileDialog } from "@/components/RemoteFileDialog";
import type { BrowsableRemoteFileSource, RemoteDirListing } from "@/remote/fileSource";

const tree: Record<string, RemoteDirListing> = {
  "": {
    path: "",
    parent: null,
    entries: [
      { name: "run", path: "run", isDir: true },
      { name: "a.pdb", path: "a.pdb", isDir: false, size: 512 },
      { name: "notes.txt", path: "notes.txt", isDir: false, size: 5 },
    ],
  },
  run: {
    path: "run",
    parent: "",
    entries: [
      { name: "big.pdb", path: "run/big.pdb", isDir: false, size: 3 * 1024 * 1024 },
      { name: "mid.pdb", path: "run/mid.pdb", isDir: false, size: 2048 },
      { name: "x.pdb", path: "run/x.pdb", isDir: false },
    ],
  },
  empty: { path: "empty", parent: "", entries: [] },
};

function makeSource(overrides: Partial<BrowsableRemoteFileSource> = {}): BrowsableRemoteFileSource {
  return {
    mode: "browse",
    label: "Open from server...",
    list: vi.fn(async (path: string) => {
      const listing = tree[path];
      if (!listing) throw new Error(`Not a folder: ${path}`);
      return listing;
    }),
    read: vi.fn(async (path: string) => new File(["ATOM"], path.split("/").pop()!)),
    ...overrides,
  };
}

const accept = (name: string) => name.endsWith(".pdb");

function entry(name: string): HTMLElement {
  const el = screen
    .getAllByTestId("remote-file-dialog-entry")
    .find((e) => e.getAttribute("data-name") === name);
  if (!el) throw new Error(`no entry ${name}`);
  return el;
}

describe("RemoteFileDialog", () => {
  afterEach(cleanup);

  it("lists the root, disables files the node can't open, and shows sizes", async () => {
    render(
      <RemoteFileDialog
        source={makeSource()}
        title="Open structure"
        accept={accept}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Open structure");
    await waitFor(() => expect(entry("a.pdb")).toBeEnabled());
    expect(entry("notes.txt")).toBeDisabled();
    expect(entry("run")).toHaveAttribute("data-kind", "dir");
    expect(entry("a.pdb")).toHaveTextContent("512 B");
    expect(screen.getByTestId("remote-file-dialog-up")).toBeDisabled();
    expect(screen.getByTestId("remote-file-dialog-open")).toBeDisabled();
  });

  it("navigates into folders and back up, then opens the selected file", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const source = makeSource();
    render(
      <RemoteFileDialog
        source={source}
        title="Open"
        accept={accept}
        onPick={onPick}
        onClose={onClose}
      />,
    );
    await waitFor(() => entry("run"));
    fireEvent.click(entry("run"));
    await waitFor(() =>
      expect(screen.getByTestId("remote-file-dialog-path")).toHaveTextContent("/run"),
    );
    expect(entry("big.pdb")).toHaveTextContent("3.0 MB");
    expect(entry("mid.pdb")).toHaveTextContent("2.0 KB");

    fireEvent.click(screen.getByTestId("remote-file-dialog-up"));
    await waitFor(() => entry("a.pdb"));
    fireEvent.click(entry("run"));
    await waitFor(() => entry("x.pdb"));

    fireEvent.click(entry("x.pdb"));
    fireEvent.click(screen.getByTestId("remote-file-dialog-open"));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(source.read).toHaveBeenCalledWith("run/x.pdb");
    expect(onPick.mock.calls[0][0].name).toBe("x.pdb");
    expect(onClose).toHaveBeenCalled();
  });

  it("reopens in the folder it showed last, and opens a file on double-click", async () => {
    const source = makeSource();
    const first = render(
      <RemoteFileDialog
        source={source}
        title="Open"
        accept={accept}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => entry("run"));
    fireEvent.click(entry("run"));
    await waitFor(() => entry("x.pdb"));
    first.unmount();

    const onPick = vi.fn();
    render(
      <RemoteFileDialog
        source={source}
        title="Open"
        accept={accept}
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => entry("x.pdb"));
    fireEvent.doubleClick(entry("x.pdb"));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
  });

  it("starts in the source's initial folder and says when a folder is empty", async () => {
    render(
      <RemoteFileDialog
        source={makeSource({ initialPath: () => "empty" })}
        title="Open"
        accept={accept}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent("This folder is empty."),
    );
  });

  it("shows a listing error", async () => {
    const source = makeSource({
      initialPath: () => "missing",
      read: vi.fn().mockRejectedValue("denied"),
    });
    render(
      <RemoteFileDialog
        source={source}
        title="Open"
        accept={accept}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("remote-file-dialog-error")).toHaveTextContent(
        "Not a folder: missing",
      ),
    );
  });

  it("shows a read error and stays open", async () => {
    const onClose = vi.fn();
    const source = makeSource({ read: vi.fn().mockRejectedValue("denied") });
    render(
      <RemoteFileDialog
        source={source}
        title="Open"
        accept={accept}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() => entry("a.pdb"));
    fireEvent.doubleClick(entry("a.pdb"));
    await waitFor(() =>
      expect(screen.getByTestId("remote-file-dialog-error")).toHaveTextContent("denied"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button, Cancel, the backdrop and Escape", async () => {
    const onClose = vi.fn();
    render(
      <RemoteFileDialog
        source={makeSource()}
        title="Open"
        accept={accept}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() => entry("a.pdb"));
    // A click inside the panel does not close it.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("remote-file-dialog-close"));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByTestId("remote-file-dialog-backdrop"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("keeps pointer events from reaching the node behind the portal", async () => {
    const onNodeMouseDown = vi.fn();
    render(
      <div onMouseDown={onNodeMouseDown} onPointerDown={onNodeMouseDown}>
        <RemoteFileDialog
          source={makeSource()}
          title="Open"
          accept={accept}
          onPick={vi.fn()}
          onClose={vi.fn()}
        />
      </div>,
    );
    await waitFor(() => entry("a.pdb"));
    fireEvent.mouseDown(entry("a.pdb"));
    fireEvent.pointerDown(entry("a.pdb"));
    expect(onNodeMouseDown).not.toHaveBeenCalled();
  });
});
