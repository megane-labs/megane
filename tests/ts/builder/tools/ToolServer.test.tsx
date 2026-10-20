/**
 * Python tools in the top bar: the Tools menu, the Tool server dialog, the
 * launch-link / site-server auto-connect, and each tool's form.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { ToolServerDialog, toolsMenuItems, useToolServerLaunch } from "@/builder/tools/ToolServer";
import { ToolDialog } from "@/builder/tools/ToolDialog";
import { parseElement } from "@/builder/tools/ToolFields";
import { Menu } from "@/builder/Menu";
import { useToolsStore } from "@/builder/tools/store";
import { useBuilderStore } from "@/builder/store";
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
/** Open the Tools menu and choose a tool. */
const pick = (name: string) => {
  click("builder-tools");
  click(`builder-tools-button-${name}`);
};

/** The Tools menu, the server dialog and the tool form, wired as `BuilderApp` wires them. */
function Tools({ serverOpen = true }: { serverOpen?: boolean }) {
  useToolServerLaunch();
  const status = useToolsStore((s) => s.status);
  const connection = useToolsStore((s) => s.connection);
  const openForm = useToolsStore((s) => s.openForm);
  const openTool = useToolsStore((s) => s.openTool);
  const [server, setServer] = useState(serverOpen);
  return (
    <>
      <Menu
        testId="builder-tools"
        label="Tools"
        items={toolsMenuItems({ status, connection, openForm }, () => setServer(true))}
      />
      {server && <ToolServerDialog onClose={() => setServer(false)} />}
      {openTool && <ToolDialog key={openTool.name} tool={openTool} />}
    </>
  );
}

beforeEach(() => {
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
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

/** Connect through the dialog, then close it: the tools are in the menu. */
async function connect() {
  render(<Tools />);
  change("builder-tools-token", "tok");
  await act(async () => click("builder-tools-connect"));
  await screen.findByTestId("builder-tools-connected");
  click("builder-tools-dialog-close");
}

describe("Tools menu and Tool server dialog", () => {
  it("says no server is connected, and opens the server dialog", () => {
    render(<Tools serverOpen={false} />);
    click("builder-tools");
    const status = screen.getByTestId("builder-tools-status") as HTMLButtonElement;
    expect(status.textContent).toBe("No tool server connected");
    expect(status.disabled).toBe(true);
    click("builder-tools-server");
    expect(screen.getByTestId("builder-tools-dialog")).toBeTruthy();
    change("builder-tools-url", "http://h:2/mcp");
    expect(useToolsStore.getState().url).toBe("http://h:2/mcp");
    // A click inside the form keeps it; Escape and Close both close it.
    fireEvent.click(screen.getByTestId("builder-tools-dialog"));
    expect(screen.getByTestId("builder-tools-dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-tools-dialog")).toBeNull();
    click("builder-tools");
    click("builder-tools-server");
    click("builder-tools-dialog-close");
    expect(screen.queryByTestId("builder-tools-dialog")).toBeNull();
  });

  it("says it is connecting while the server answers", async () => {
    let answer!: (c: ToolConnection) => void;
    mocks.connect.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    render(<Tools />);
    act(() => click("builder-tools-connect"));
    click("builder-tools");
    expect(screen.getByTestId("builder-tools-status").textContent).toBe("Connecting…");
    await act(async () => answer(connection()));
    expect(screen.getByTestId("builder-tools-connected")).toBeTruthy();
  });

  it("Cancel gives up on a connect that does not answer", async () => {
    let answer!: (c: ToolConnection) => void;
    mocks.connect.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    render(<Tools />);
    act(() => click("builder-tools-connect"));
    expect(screen.getByTestId("builder-tools-connect").textContent).toBe("Connecting…");
    expect((screen.getByTestId("builder-tools-connect") as HTMLButtonElement).disabled).toBe(true);
    click("builder-tools-connect-cancel");
    expect(useToolsStore.getState().status).toBe("idle");
    expect(screen.queryByTestId("builder-tools-connect-cancel")).toBeNull();
    // The late connection is dropped.
    const late = connection();
    const close = vi.spyOn(late, "close");
    await act(async () => answer(late));
    expect(close).toHaveBeenCalled();
    expect(useToolsStore.getState().status).toBe("idle");
    expect(screen.queryByTestId("builder-tools-connected")).toBeNull();
  });

  it("Enter in the URL or token field connects", async () => {
    render(<Tools />);
    change("builder-tools-token", "tok");
    await act(async () => fireEvent.submit(screen.getByTestId("builder-tools-form")));
    expect(mocks.connect).toHaveBeenCalledWith("http://127.0.0.1:8765/mcp", "tok");
    await screen.findByTestId("builder-tools-connected");
    // Connected, Enter does not reconnect; nor without a URL.
    await act(async () => fireEvent.submit(screen.getByTestId("builder-tools-form")));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await act(async () => click("builder-tools-disconnect"));
    change("builder-tools-url", "  ");
    await act(async () => fireEvent.submit(screen.getByTestId("builder-tools-form")));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("connects and lists the tools by category", async () => {
    await connect();
    expect(mocks.connect).toHaveBeenCalledWith("http://127.0.0.1:8765/mcp", "tok");
    click("builder-tools");
    expect(screen.getByTestId("builder-tools-server-name").textContent).toBe(
      "megane-builder-tools",
    );
    expect(screen.getByTestId("builder-tools-button-liquid_box").textContent).toBe("Liquid box…");
    expect(screen.getByText("Solvation")).toBeTruthy();
    click("builder-tools-server");
    expect(screen.getByTestId("builder-tools-connected").textContent).toContain("3 tools");
    await act(async () => click("builder-tools-disconnect"));
    expect(screen.queryByTestId("builder-tools-connected")).toBeNull();
    // Disconnect stays disconnected: the click does not submit the form.
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    click("builder-tools");
    expect(screen.queryByTestId("builder-tools-button-liquid_box")).toBeNull();
  });

  it("shows connection errors, empty servers, unsupported and unformable tools", async () => {
    mocks.connect.mockImplementationOnce(async () => {
      throw new Error("refused");
    });
    render(<Tools />);
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
    expect(screen.getByTestId("builder-tools-connected").textContent).toContain("1 tool ");
    click("builder-tools");
    const button = screen.getByTestId("builder-tools-button-oneof") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("cannot build a form");
    // The reason is in the menu itself, not only in the tooltip.
    expect(screen.getByTestId("builder-tools-unavailable-oneof").textContent).toMatch(
      /^Unavailable: /,
    );
    click("builder-tools"); // closes the menu again

    mocks.connect.mockImplementationOnce(async () => connection([]));
    await act(async () => click("builder-tools-disconnect"));
    await act(async () => click("builder-tools-connect"));
    click("builder-tools");
    expect(screen.getByText("This server offers no Builder tools.")).toBeTruthy();
  });

  it("connects from #tools=…&token=… and strips the token from the address", async () => {
    window.history.replaceState(null, "", "/builder.html#tools=http%3A%2F%2Fh%3A1%2Fmcp&token=abc");
    render(<Tools />);
    await screen.findByTestId("builder-tools-connected");
    expect(mocks.connect).toHaveBeenCalledWith("http://h:1/mcp", "abc");
    expect(window.location.hash).toBe("");
  });

  it("connects to the site tool server on load while it is the chosen one", async () => {
    vi.stubEnv("VITE_BUILDER_TOOLS_URL", "https://t.example/mcp");
    useToolsStore.setState({ url: "https://t.example/mcp" });
    render(<Tools />);
    await screen.findByTestId("builder-tools-connected");
    expect(mocks.connect).toHaveBeenCalledWith("https://t.example/mcp", "");
  });

  it("does not auto-connect to another server or without a site server", async () => {
    render(<Tools />);
    cleanup();
    vi.stubEnv("VITE_BUILDER_TOOLS_URL", "https://t.example/mcp");
    render(<Tools />);
    await act(async () => undefined);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("ToolDialog", () => {
  it("runs a new-document tool and closes", async () => {
    await connect();
    pick("liquid_box");
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
    pick("polymer_chain");
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
    pick("solvate");
    expect(screen.getByTestId("builder-tool-needs-document")).toBeTruthy();
    expect(screen.getByTestId("builder-tool-field-document").textContent).toContain("none is open");
    click("builder-tool-close");

    act(() => {
      useBuilderStore.getState().newCell(20);
      useBuilderStore
        .getState()
        .pushOp({ op: "add_atom", id: "a", element: 6, position: [10, 10, 10] });
    });
    pick("solvate");
    expect(screen.queryByTestId("builder-tool-needs-document")).toBeNull();
    expect(screen.getByTestId("builder-tool-field-document").textContent).toContain("1 atoms");
    fireEvent.click(screen.getByTestId("builder-tool-dialog"));
    expect(screen.getByTestId("builder-tool-dialog")).toBeTruthy();
    click("builder-tool-close");
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();

    pick("liquid_box");
    expect(screen.getByTestId("builder-tool-replaces")).toBeTruthy();
    // Running it asks first; No leaves the document alone.
    await act(async () => click("builder-tool-run"));
    expect(useBuilderStore.getState().confirm?.confirmLabel).toBe("Discard edits");
    expect(useBuilderStore.getState().confirm?.message).toMatch(/^Running Liquid box replaces/);
    await act(async () => useBuilderStore.getState().resolveConfirm(false));
    expect(useBuilderStore.getState().edits).toHaveLength(1);
    expect(screen.getByTestId("builder-tool-dialog")).toBeTruthy();
    await act(async () => click("builder-tool-run"));
    await act(async () => useBuilderStore.getState().resolveConfirm(true));
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();
    expect(useBuilderStore.getState().edits).toHaveLength(0);
  });

  it("remembers a form's values for the session, and Enter runs it", async () => {
    await connect();
    pick("liquid_box");
    change("builder-tool-field-density", "0.7");
    const seed = (screen.getByTestId("builder-tool-field-seed") as HTMLInputElement).value;
    click("builder-tool-close");
    pick("liquid_box");
    expect((screen.getByTestId("builder-tool-field-density") as HTMLInputElement).value).toBe(
      "0.7",
    );
    expect((screen.getByTestId("builder-tool-field-seed") as HTMLInputElement).value).toBe(seed);
    let sent: Record<string, unknown> = {};
    mocks.call = async (name, args) => {
      sent = args;
      return recorded(name);
    };
    await act(async () => fireEvent.submit(screen.getByTestId("builder-tool-form")));
    expect(sent).toMatchObject({ density: 0.7 });
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();
  });

  it("Enter does nothing while the form has a problem", async () => {
    await connect();
    pick("polymer_chain");
    change("builder-tool-field-length", "0");
    const calls = vi.fn();
    mocks.call = async (name) => {
      calls();
      return recorded(name);
    };
    await act(async () => fireEvent.submit(screen.getByTestId("builder-tool-form")));
    expect(calls).not.toHaveBeenCalled();
    expect(screen.getByTestId("builder-tool-run").getAttribute("title")).toContain("at least 1");
  });

  it("shows progress and cancels", async () => {
    await connect();
    let release!: () => void;
    mocks.call = async (name, _a, o) => {
      o.onProgress?.(0.4, "packing with packmol");
      await new Promise<void>((r) => (release = r));
      return recorded(name);
    };
    pick("liquid_box");
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
    pick("kitchen");
    change("builder-tool-field-label", "abc");
    fireEvent.click(screen.getByTestId("builder-tool-field-flag"));
    change("builder-tool-field-group-x", "3");
    // An element by symbol (any case) or by number.
    change("builder-tool-field-el", "fe");
    expect(screen.getByTestId("builder-tool-field-el-resolved").textContent).toBe("Z = 26");
    change("builder-tool-field-el", "Qq");
    expect(screen.getByTestId("builder-tool-field-el-resolved").textContent).toBe("not an element");
    expect(screen.getByTestId("builder-tool-error").textContent).toContain(
      "element symbol (e.g. Fe) or an atomic number",
    );
    change("builder-tool-field-el", "");
    expect(screen.getByTestId("builder-tool-field-el-resolved").textContent).toBe("");
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

describe("Tools through a host bridge", () => {
  const SERVERS = [
    { id: "builder-tools", kind: "stdio" as const, description: "uvx megane-builder-tools" },
    { id: "lab", kind: "http" as const, description: "https://lab.example/mcp" },
  ];

  function bridgeOf(servers = SERVERS, openSettings?: () => void) {
    return {
      configHint: "the megane.builder.mcpServers setting",
      listServers: vi.fn(async () => servers),
      connect: vi.fn(async () => connection()),
      openSettings,
    };
  }

  /** As `BuilderApp` wires the menu when the host has a bridge. */
  function BridgeTools({ serverOpen = false }: { serverOpen?: boolean }) {
    const status = useToolsStore((s) => s.status);
    const connection = useToolsStore((s) => s.connection);
    const openForm = useToolsStore((s) => s.openForm);
    const servers = useToolsStore((s) => s.servers);
    const setUrl = useToolsStore((s) => s.setUrl);
    const connect = useToolsStore((s) => s.connect);
    const [server, setServer] = useState(serverOpen);
    return (
      <>
        <Menu
          testId="builder-tools"
          label="Tools"
          items={toolsMenuItems({ status, connection, openForm, servers, setUrl, connect }, () =>
            setServer(true),
          )}
        />
        {server && <ToolServerDialog onClose={() => setServer(false)} />}
      </>
    );
  }

  it("offers each configured server in the menu and connects to the one chosen", async () => {
    const bridge = bridgeOf();
    await act(async () => useToolsStore.getState().attachBridge(bridge));
    render(<BridgeTools />);
    click("builder-tools");
    const lab = screen.getByTestId("builder-tools-connect-lab") as HTMLButtonElement;
    expect(lab.textContent).toBe("Connect to lab");
    expect(lab.title).toBe("https://lab.example/mcp");
    await act(async () => click("builder-tools-connect-lab"));
    expect(bridge.connect).toHaveBeenCalledWith("lab");
    expect(screen.getByTestId("builder-tools-connected")).toBeTruthy();
    expect(mocks.connect).not.toHaveBeenCalled();
    // While connected, the menu lists the tools instead of the servers.
    click("builder-tools");
    expect(screen.queryByTestId("builder-tools-connect-lab")).toBeNull();
    expect(screen.getByTestId("builder-tools-button-solvate")).toBeTruthy();
  });

  it("picks a server in the form, says what it runs, and opens the settings", async () => {
    const openSettings = vi.fn();
    const bridge = bridgeOf(SERVERS, openSettings);
    await act(async () => useToolsStore.getState().attachBridge(bridge));
    render(<BridgeTools serverOpen />);
    await act(async () => undefined);
    expect(screen.queryByTestId("builder-tools-url")).toBeNull();
    expect(screen.queryByTestId("builder-tools-token")).toBeNull();
    expect(screen.getByTestId("builder-tools-server-description").textContent).toBe(
      "Runs uvx megane-builder-tools",
    );
    change("builder-tools-server-select", "lab");
    expect(screen.getByTestId("builder-tools-server-description").textContent).toBe(
      "Connects to https://lab.example/mcp",
    );
    await act(async () => click("builder-tools-connect"));
    expect(bridge.connect).toHaveBeenCalledWith("lab");
    expect((screen.getByTestId("builder-tools-server-select") as HTMLSelectElement).disabled).toBe(
      true,
    );
    click("builder-tools-open-settings");
    expect(openSettings).toHaveBeenCalled();
  });

  it("says where to add a server when none is configured", async () => {
    await act(async () => useToolsStore.getState().attachBridge(bridgeOf([])));
    render(<BridgeTools serverOpen />);
    await act(async () => undefined);
    expect(screen.getByTestId("builder-tools-no-servers").textContent).toContain(
      "the megane.builder.mcpServers setting",
    );
    expect(screen.queryByTestId("builder-tools-open-settings")).toBeNull();
  });

  it("says it is listing until the host answers", async () => {
    let answer!: (servers: typeof SERVERS) => void;
    const bridge = bridgeOf();
    bridge.listServers.mockImplementation(() => new Promise((r) => (answer = r)));
    act(() => void useToolsStore.getState().attachBridge(bridge));
    render(<BridgeTools serverOpen />);
    expect(screen.getByText("Listing the tool servers…")).toBeTruthy();
    await act(async () => answer(SERVERS));
    expect(screen.getByTestId("builder-tools-server-select")).toBeTruthy();
  });
});

describe("parseElement", () => {
  it("reads a symbol in any case or an atomic number", () => {
    expect(parseElement("Fe")).toBe(26);
    expect(parseElement(" cl ")).toBe(17);
    expect(parseElement("6")).toBe(6);
    expect(parseElement("999")).toBeNaN();
    expect(parseElement("Xx")).toBeNaN();
    expect(parseElement("")).toBeNaN();
  });
});
