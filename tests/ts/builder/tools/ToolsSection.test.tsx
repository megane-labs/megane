import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { ToolsSection } from "@/builder/tools/ToolsSection";
import { useToolsStore } from "@/builder/tools/store";
import { useBuilderStore } from "@/builder/store";
import { SECTIONS_STORAGE_KEY } from "@/builder/Section";
import { META_KEY, parseResult, parseTools } from "@/builder/tools/contract";
import type { CallOptions, CallOutcome, ToolConnection } from "@/builder/tools/client";
import { CALLS, TOOLS } from "./fixtures";

const mocks = vi.hoisted(() => ({
  call: null as
    | null
    | ((name: string, args: Record<string, unknown>, o: CallOptions) => Promise<CallOutcome>),
  connect: vi.fn(),
  tools: null as unknown,
}));

vi.mock("@/builder/tools/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/builder/tools/client")>();
  return { ...real, connectToolServer: mocks.connect };
});

const recorded = (name: string): CallOutcome => ({
  ok: true,
  result: parseResult(CALLS[name].result.structuredContent),
  summary: `${name} done.`,
});

function connection(tools = TOOLS): ToolConnection {
  return {
    serverName: "megane-builder-tools",
    serverVersion: "0.1.0",
    listing: parseTools(tools),
    call: (name, args, o) => mocks.call!(name, args, o),
    close: async () => undefined,
  };
}

const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const change = (id: string, value: string) =>
  fireEvent.change(screen.getByTestId(id), { target: { value } });

beforeEach(() => {
  localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify({ tools: true }));
  mocks.connect.mockReset();
  mocks.connect.mockImplementation(async () => connection());
  mocks.call = async (name) => recorded(name);
  useBuilderStore.setState(useBuilderStore.getInitialState(), true);
  useToolsStore.setState(
    { ...useToolsStore.getInitialState(), url: "http://127.0.0.1:8765/mcp" },
    true,
  );
  window.history.replaceState(null, "", "/builder.html");
});
afterEach(cleanup);

async function connect() {
  render(<ToolsSection />);
  change("builder-tools-token", "tok");
  await act(async () => click("builder-tools-connect"));
  await screen.findByTestId("builder-tools-list");
}

describe("ToolsSection", () => {
  it("connects and lists the tools by category", async () => {
    await connect();
    expect(mocks.connect).toHaveBeenCalledWith("http://127.0.0.1:8765/mcp", "tok");
    expect(screen.getByTestId("builder-section-tools-summary").textContent).toBe(
      "megane-builder-tools",
    );
    expect(screen.getByTestId("builder-tools-button-liquid_box").textContent).toBe("Liquid box");
    expect(screen.getByText("Solvation")).toBeTruthy();
    await act(async () => click("builder-tools-disconnect"));
    expect(screen.queryByTestId("builder-tools-list")).toBeNull();
  });

  it("shows connection errors, empty servers, unsupported and unformable tools", async () => {
    mocks.connect.mockImplementationOnce(async () => {
      throw new Error("refused");
    });
    render(<ToolsSection />);
    await act(async () => click("builder-tools-connect"));
    expect(screen.getByTestId("builder-tools-error").textContent).toContain("refused");

    const odd = [
      { name: "future", inputSchema: { type: "object" }, _meta: { [META_KEY]: { contract: 5 } } },
      {
        name: "oneof",
        title: "One of",
        inputSchema: { type: "object", properties: { x: { oneOf: [] } } },
        _meta: { [META_KEY]: { contract: 1, category: "bulk", apply: "new_document" } },
      },
    ];
    mocks.connect.mockImplementationOnce(async () => connection(odd));
    await act(async () => click("builder-tools-connect"));
    expect(screen.getByTestId("builder-tools-unsupported").textContent).toContain("future");
    const button = screen.getByTestId("builder-tools-button-oneof") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("cannot build a form");

    mocks.connect.mockImplementationOnce(async () => connection([]));
    await act(async () => click("builder-tools-disconnect"));
    await act(async () => click("builder-tools-connect"));
    expect(screen.getByText("This server offers no Builder tools.")).toBeTruthy();
  });

  it("connects from #tools=…&token=… and strips the token from the address", async () => {
    window.history.replaceState(null, "", "/builder.html#tools=http%3A%2F%2Fh%3A1%2Fmcp&token=abc");
    render(<ToolsSection />);
    await screen.findByTestId("builder-tools-list");
    expect(mocks.connect).toHaveBeenCalledWith("http://h:1/mcp", "abc");
    expect(window.location.hash).toBe("");
  });
});

describe("ToolDialog", () => {
  it("runs a new-document tool and closes", async () => {
    await connect();
    click("builder-tools-button-liquid_box");
    expect(screen.getByTestId("builder-tool-dialog")).toBeTruthy();
    change("builder-tool-field-components-0-molecule", "preset:water");
    change("builder-tool-field-components-0-count", "50");
    click("builder-tool-field-components-add");
    expect(screen.getByTestId("builder-tool-field-components-row-1")).toBeTruthy();
    click("builder-tool-field-components-remove-1");
    change("builder-tool-field-shape", "orthorhombic");
    change("builder-tool-field-aspect-2", "2");
    change("builder-tool-field-density", "0.8");
    const seedBefore = (screen.getByTestId("builder-tool-field-seed") as HTMLInputElement).value;
    click("builder-tool-field-seed-reroll");
    change("builder-tool-field-seed", "7");
    expect(seedBefore).not.toBe("");

    let sent: Record<string, unknown> = {};
    mocks.call = async (name, args) => {
      sent = args;
      return recorded(name);
    };
    await act(async () => click("builder-tool-run"));
    expect(sent).toMatchObject({ seed: 7, density: 0.8, shape: "orthorhombic", aspect: [1, 1, 2] });
    expect((sent.components as { count: number }[])[0].count).toBe(50);
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();
    expect(useBuilderStore.getState().result!.snapshot.nAtoms).toBe(300);
  });

  it("keeps the form open on a tool error and validates before running", async () => {
    await connect();
    click("builder-tools-button-polymer_chain");
    change("builder-tool-field-monomer", "preset:ethanol");
    change("builder-tool-field-head", "0");
    change("builder-tool-field-tail", "1");
    change("builder-tool-field-length", "0");
    expect(screen.getByTestId("builder-tool-error").textContent).toContain("at least 1");
    expect((screen.getByTestId("builder-tool-run") as HTMLButtonElement).disabled).toBe(true);
    change("builder-tool-field-length", "");
    expect(screen.getByTestId("builder-tool-error").textContent).toContain("must be a number");
    change("builder-tool-field-length", "12");
    mocks.call = async () => ({
      ok: false,
      error: "The head and tail atoms must be different atoms.",
    });
    await act(async () => click("builder-tool-run"));
    expect(screen.getByTestId("builder-tool-error").textContent).toContain("different atoms");
    expect(screen.getByTestId("builder-tool-dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();
  });

  it("insert tools need a document; the replace warning shows for edited documents", async () => {
    await connect();
    click("builder-tools-button-solvate");
    expect(screen.getByTestId("builder-tool-needs-document")).toBeTruthy();
    expect(screen.getByTestId("builder-tool-field-document").textContent).toContain("none is open");
    click("builder-tool-close");

    act(() => {
      useBuilderStore.getState().newCell(20);
      useBuilderStore
        .getState()
        .pushOp({ op: "add_atom", id: "a", element: 6, position: [10, 10, 10] });
    });
    click("builder-tools-button-solvate");
    expect(screen.queryByTestId("builder-tool-needs-document")).toBeNull();
    expect(screen.getByTestId("builder-tool-field-document").textContent).toContain("1 atoms");
    fireEvent.click(screen.getByTestId("builder-tool-dialog"));
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();

    click("builder-tools-button-liquid_box");
    expect(screen.getByTestId("builder-tool-replaces")).toBeTruthy();
  });

  it("shows progress and cancels", async () => {
    await connect();
    let release!: () => void;
    mocks.call = async (name, _a, o) => {
      o.onProgress?.(0.4, "packing with packmol");
      await new Promise<void>((r) => (release = r));
      return recorded(name);
    };
    click("builder-tools-button-liquid_box");
    act(() => click("builder-tool-run"));
    await waitFor(() =>
      expect(screen.getByTestId("builder-tool-progress").textContent).toContain("packing"),
    );
    expect((screen.getByTestId("builder-tool-close") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("builder-tool-dialog")).toBeTruthy();
    click("builder-tool-cancel");
    await act(async () => release());
    expect(screen.getByTestId("builder-tool-error").textContent).toBe("Cancelled.");
    expect(useBuilderStore.getState().source).toBeNull();
  });

  it("renders every control kind", async () => {
    const kitchen = [
      {
        name: "kitchen",
        title: "Kitchen sink",
        description: "All controls.",
        inputSchema: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string", maxLength: 8, description: "A label." },
            flag: { type: "boolean" },
            group: { type: "object", title: "Group", properties: { x: { type: "number" } } },
            el: { type: "integer", "x-megane-widget": "element" },
            cell: { type: "array", "x-megane-widget": "cell" },
            sel: { type: "array", "x-megane-widget": "selection", title: "Atoms" },
            loose: { type: "integer", "x-megane-widget": "atom" },
          },
        },
        _meta: { [META_KEY]: { contract: 1, category: "other", apply: "new_document" } },
      },
    ];
    mocks.connect.mockImplementation(async () => connection(kitchen));
    await connect();
    click("builder-tools-button-kitchen");
    change("builder-tool-field-label", "abc");
    fireEvent.click(screen.getByTestId("builder-tool-field-flag"));
    change("builder-tool-field-group-x", "3");
    change("builder-tool-field-el", "8");
    change("builder-tool-field-cell-b", "15");
    change("builder-tool-field-loose", "2");
    expect(screen.getByText("O")).toBeTruthy();
    expect(screen.getByTestId("builder-tool-field-sel").textContent).toContain("0 selected");
    let sent: Record<string, unknown> = {};
    mocks.call = async (_n, args) => {
      sent = args;
      return recorded("polymer_chain");
    };
    await act(async () => click("builder-tool-run"));
    expect(sent).toEqual({
      label: "abc",
      flag: true,
      group: { x: 3 },
      el: 8,
      cell: [20, 0, 0, 0, 15, 0, 0, 0, 20],
      sel: [],
      loose: 2,
    });
  });
});
