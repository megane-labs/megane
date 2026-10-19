/**
 * megane Builder in JupyterLab: the megane sidebar panel, the commands, the
 * file-browser entry, the one Builder tab, and files read from and saved into
 * the server's contents.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mountBuilder, openStructureFile, closeDocument, mounts } = vi.hoisted(() => {
  const mounts: { el: HTMLElement; host: Record<string, unknown>; dispose: () => void }[] = [];
  return {
    mounts,
    mountBuilder: vi.fn((el: HTMLElement, host: Record<string, unknown>) => {
      const m = { el, host, dispose: vi.fn() };
      mounts.push(m);
      return { open: vi.fn(), dispose: m.dispose };
    }),
    openStructureFile: vi.fn(async (_file: File) => true),
    closeDocument: vi.fn(),
  };
});

vi.mock("@megane/builder/mount", () => ({ mountBuilder }));
vi.mock("@megane/builder/open", () => ({ openStructureFile }));
vi.mock("@megane/builder/store", () => ({
  useBuilderStore: { getState: () => ({ closeDocument }) },
}));

import {
  basename,
  dirname,
  isBuilderPath,
  readContentsFile,
  saveToContents,
  BUILDER_EXTENSIONS,
  type SavePrompts,
} from "../../../jupyterlab-megane/src/builder/contents";
import {
  BuilderWidget,
  BUILDER_WIDGET_ID,
} from "../../../jupyterlab-megane/src/builder/BuilderWidget";
import { BuilderSidebar } from "../../../jupyterlab-megane/src/builder/sidebar";
import {
  activateBuilder,
  builderPlugin,
  CommandIDs,
  dialogPrompts,
  type FileBrowserLike,
} from "../../../jupyterlab-megane/src/builder/plugin";
import { meganeIcon, MEGANE_ICON_SVG } from "../../../jupyterlab-megane/src/builder/icon";
import * as apputils from "@jupyterlab/apputils";
import { BUILDER_EXTENSIONS as VSCODE_EXTENSIONS } from "../../../vscode-megane/src/extension";

vi.mock("vscode", () => ({}));

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

async function fileBytes(file: File): Promise<number[]> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
    reader.readAsArrayBuffer(file);
  });
}

beforeEach(() => {
  mounts.length = 0;
  mountBuilder.mockClear();
  openStructureFile.mockClear();
  closeDocument.mockClear();
});

describe("contents helpers", () => {
  it("paths", () => {
    expect(basename("a/b/c.pdb")).toBe("c.pdb");
    expect(basename("c.pdb")).toBe("c.pdb");
    expect(dirname("a/b/c.pdb")).toBe("a/b");
    expect(dirname("c.pdb")).toBe("");
  });

  it("offers structure files only, matching the VS Code Explorer entry", () => {
    expect(BUILDER_EXTENSIONS).toEqual(VSCODE_EXTENSIONS);
    for (const p of ["x/caffeine.SDF", "w.xyz", "POSCAR", "CONTCAR_relaxed", "a/b.cif"]) {
      expect(isBuilderPath(p)).toBe(true);
    }
    for (const p of ["traj.xtc", "grid.cube", "notes.txt", "pipe.megane.json", "XYZ"]) {
      expect(isBuilderPath(p)).toBe(false);
    }
  });

  it("reads a file as bytes, binary intact", async () => {
    const get = vi.fn(async () => ({ content: `${b64([0, 255, 10])}\n` }));
    const file = await readContentsFile({ get } as never, "data/run.traj");
    expect(get).toHaveBeenCalledWith("data/run.traj", {
      type: "file",
      format: "base64",
      content: true,
    });
    expect(file.name).toBe("run.traj");
    expect(await fileBytes(file)).toEqual([0, 255, 10]);
    const empty = await readContentsFile(
      { get: async () => ({ content: null }) } as never,
      "e.xyz",
    );
    expect(empty.size).toBe(0);
  });
});

describe("saveToContents", () => {
  const file = { name: "water.xyz", text: "3\n", format: "xyz" as const };
  function contents(existing: string[] = []) {
    return {
      get: vi.fn(async (path: string) => {
        if (!existing.includes(path)) throw new Error("404");
        return {};
      }),
      save: vi.fn(async () => ({})),
    };
  }
  const prompts = (path: string | null, overwrite = false): SavePrompts => ({
    path: vi.fn(async () => path),
    overwrite: vi.fn(async () => overwrite),
  });

  it("suggests the folder, writes the text, and says where", async () => {
    const c = contents();
    const p = prompts("/work/water.xyz");
    expect(await saveToContents(c as never, file, "work", p)).toBe("Saved work/water.xyz");
    expect(p.path).toHaveBeenCalledWith("work/water.xyz");
    expect(c.save).toHaveBeenCalledWith("work/water.xyz", {
      type: "file",
      format: "text",
      content: "3\n",
    });
    expect(p.overwrite).not.toHaveBeenCalled();
  });

  it("at the root, suggests the bare name", async () => {
    const p = prompts("water.xyz");
    await saveToContents(contents() as never, file, "", p);
    expect(p.path).toHaveBeenCalledWith("water.xyz");
  });

  it("cancelled or blank: writes nothing", async () => {
    for (const answer of [null, "  "]) {
      const c = contents();
      expect(await saveToContents(c as never, file, "", prompts(answer))).toBeNull();
      expect(c.save).not.toHaveBeenCalled();
    }
  });

  it("asks before replacing a file", async () => {
    const declined = contents(["water.xyz"]);
    expect(await saveToContents(declined as never, file, "", prompts("water.xyz"))).toBeNull();
    expect(declined.save).not.toHaveBeenCalled();
    const accepted = contents(["water.xyz"]);
    expect(await saveToContents(accepted as never, file, "", prompts("water.xyz", true))).toBe(
      "Saved water.xyz",
    );
  });
});

describe("dialogPrompts", () => {
  it("asks for the path and the overwrite with JupyterLab dialogs", async () => {
    const getText = vi
      .spyOn(apputils.InputDialog, "getText")
      .mockResolvedValueOnce({ button: { accept: true }, value: "a/b.xyz" } as never)
      .mockResolvedValueOnce({ button: { accept: false }, value: "x" } as never);
    expect(await dialogPrompts.path("b.xyz")).toBe("a/b.xyz");
    expect(await dialogPrompts.path("b.xyz")).toBeNull();
    expect(getText.mock.calls[0][0]).toMatchObject({ text: "b.xyz", okLabel: "Save" });

    const show = vi
      .spyOn(apputils, "showDialog")
      .mockResolvedValueOnce({ button: { accept: true } } as never);
    expect(await dialogPrompts.overwrite("a/b.xyz")).toBe(true);
    expect((show.mock.calls[0][0] as { body: string }).body).toContain("a/b.xyz already exists");
  });
});

describe("BuilderWidget", () => {
  it("is one closable tab that mounts the Builder once, scoped, without Tools", async () => {
    const save = vi.fn(async () => "Saved");
    const w = new BuilderWidget(save);
    expect(w.id).toBe(BUILDER_WIDGET_ID);
    expect(w.title.label).toBe("Megane Builder");
    expect(w.title.closable).toBe(true);
    expect(w.node.dataset.lmSuppressShortcuts).toBe("true");

    (w as unknown as { onAfterAttach(): void }).onAfterAttach();
    (w as unknown as { onAfterAttach(): void }).onAfterAttach();
    expect(mountBuilder).toHaveBeenCalledTimes(1);
    const host = mounts[0].host as { save: (f: unknown) => Promise<string>; tools: boolean };
    expect(host).toMatchObject({ tools: false, scopeShortcuts: true });
    await host.save({ name: "a" });
    expect(save).toHaveBeenCalledWith({ name: "a" });

    const file = new File(["x"], "w.pdb");
    expect(await w.open(file, "data")).toBe(true);
    expect(openStructureFile).toHaveBeenCalledWith(file);
    expect(w.dir).toBe("data");

    w.dispose();
    expect(mounts[0].dispose).toHaveBeenCalledTimes(1);
    expect(closeDocument).toHaveBeenCalledTimes(1);
    w.dispose();
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });
});

describe("BuilderSidebar", () => {
  it("lists the folder's structure files and opens them; Open Builder opens the tab", () => {
    const openBuilder = vi.fn();
    const openFile = vi.fn();
    const items = [
      { name: "b.pdb", path: "d/b.pdb", type: "file" },
      { name: "a.xyz", path: "d/a.xyz", type: "file" },
      { name: "notes.txt", path: "d/notes.txt", type: "file" },
      { name: "sub.pdb", path: "d/sub.pdb", type: "directory" },
    ];
    const sidebar = new BuilderSidebar({
      openBuilder,
      openFile,
      folder: () => ({ path: "d", items }),
    });
    const buttons = [
      ...sidebar.node.querySelectorAll<HTMLButtonElement>(
        '[data-testid="megane-builder-sidebar-file"]',
      ),
    ];
    expect(buttons.map((b) => b.textContent)).toEqual(["a.xyz", "b.pdb"]);
    expect(sidebar.node.textContent).toContain("Structures in /d");
    buttons[0].click();
    expect(openFile).toHaveBeenCalledWith("d/a.xyz");
    sidebar.node
      .querySelector<HTMLButtonElement>('[data-testid="megane-builder-sidebar-open"]')!
      .click();
    expect(openBuilder).toHaveBeenCalledTimes(1);

    items.length = 0;
    sidebar.refresh();
    expect(sidebar.node.textContent).toContain("No structure files in /d");
  });

  it("without a file browser, points to the context menu", () => {
    const sidebar = new BuilderSidebar({
      openBuilder: vi.fn(),
      openFile: vi.fn(),
      folder: () => null,
    });
    expect(sidebar.node.textContent).toContain("Open in Megane Builder");
  });
});

describe("builder plugin", () => {
  type Command = {
    execute: (args?: Record<string, unknown>) => unknown;
    isVisible?: (args: Record<string, unknown>) => boolean;
    label: string;
  };
  function fakeApp(files: Record<string, number[]> = {}) {
    const commands = new Map<string, Command>();
    const app = {
      serviceManager: {
        contents: {
          get: vi.fn(async (path: string) => {
            if (!(path in files)) throw new Error("not found");
            return { content: b64(files[path]) };
          }),
          save: vi.fn(async () => ({})),
        },
      },
      commands: {
        addCommand: vi.fn((id: string, cmd: Command) => commands.set(id, cmd)),
        execute: vi.fn(async (id: string, args?: Record<string, unknown>) =>
          commands.get(id)!.execute(args ?? {}),
        ),
      },
      contextMenu: { addItem: vi.fn() },
      shell: { add: vi.fn(), activateById: vi.fn() },
    };
    return { app, commands };
  }
  function fakeBrowser(selected: { path: string; type: string }[] = []): FileBrowserLike & {
    fire(): void;
  } {
    const listeners: (() => void)[] = [];
    return {
      model: {
        path: "proj",
        items: () => [{ name: "w.pdb", path: "proj/w.pdb", type: "file" }],
        pathChanged: { connect: (fn) => listeners.push(fn) },
        refreshed: { connect: (fn) => listeners.push(fn) },
      },
      selectedItems: () => selected,
      fire: () => listeners.forEach((fn) => fn()),
    };
  }

  it("takes every JupyterLab service as optional", () => {
    expect(builderPlugin.id).toBe("megane-jupyterlab:builder");
    expect(builderPlugin.optional).toHaveLength(4);
    expect(builderPlugin.autoStart).toBe(true);
  });

  it("adds the sidebar, launcher and palette entries and the file-browser menu item", () => {
    const { app } = fakeApp();
    const launcher = { add: vi.fn() };
    const palette = { addItem: vi.fn() };
    const restorer = { add: vi.fn() };
    builderPlugin.activate(
      app as never,
      restorer as never,
      fakeBrowser() as never,
      launcher as never,
      palette as never,
    );
    const [sidebar, area, options] = app.shell.add.mock.calls[0];
    expect(area).toBe("left");
    expect(options).toEqual({ rank: 850 });
    expect((sidebar as BuilderSidebar).title.icon).toBe(meganeIcon);
    expect(restorer.add).toHaveBeenCalledWith(sidebar, "megane-builder-sidebar");
    expect(launcher.add).toHaveBeenCalledWith({
      command: CommandIDs.openBuilder,
      category: "Other",
      rank: 10,
    });
    expect(palette.addItem).toHaveBeenCalledTimes(2);
    expect(app.contextMenu.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ command: CommandIDs.openInBuilder }),
    );
  });

  it("works without the optional services", () => {
    const { app, commands } = fakeApp();
    activateBuilder(app as never, null, null, null, null);
    expect(commands.has(CommandIDs.openBuilder)).toBe(true);
    const sidebar = app.shell.add.mock.calls[0][0] as BuilderSidebar;
    expect(sidebar.node.textContent).toContain("Right-click");
  });

  it("Megane Builder opens one tab and brings it back", async () => {
    const { app } = fakeApp();
    activateBuilder(app as never, null, null, null, null);
    await app.commands.execute(CommandIDs.openBuilder);
    await app.commands.execute(CommandIDs.openBuilder);
    const mains = app.shell.add.mock.calls.filter((c) => c[1] === "main");
    expect(mains).toHaveLength(1);
    expect((mains[0][0] as BuilderWidget).title.icon).toBe(meganeIcon);
    expect(app.shell.activateById).toHaveBeenCalledTimes(2);
    (mains[0][0] as BuilderWidget).dispose();
    await app.commands.execute(CommandIDs.openBuilder);
    expect(app.shell.add.mock.calls.filter((c) => c[1] === "main")).toHaveLength(2);
  });

  it("Open in Megane Builder reads the file into the tab and saves beside it", async () => {
    const { app, commands } = fakeApp({ "proj/w.pdb": [65, 66] });
    const prompts: SavePrompts = { path: vi.fn(async (p: string) => p), overwrite: vi.fn() };
    activateBuilder(app as never, null, fakeBrowser() as never, null, null, prompts);
    await app.commands.execute(CommandIDs.openInBuilder, { path: "proj/w.pdb" });
    const file = openStructureFile.mock.calls[0][0];
    expect(file.name).toBe("w.pdb");
    expect(await fileBytes(file)).toEqual([65, 66]);
    expect(commands.get(CommandIDs.openInBuilder)!.isVisible!({ path: "x.pdb" })).toBe(true);

    const tab = app.shell.add.mock.calls.find((c) => c[1] === "main")![0] as BuilderWidget;
    (tab as unknown as { onAfterAttach(): void }).onAfterAttach();
    const host = mounts[0].host as { save: (f: unknown) => Promise<string | null> };
    expect(await host.save({ name: "w.xyz", text: "t", format: "xyz" })).toBe("Saved proj/w.xyz");
  });

  it("without a path, opens the file selected in the file browser", async () => {
    const browser = fakeBrowser([
      { path: "proj/sub", type: "directory" },
      { path: "proj/readme.md", type: "file" },
      { path: "proj/w.pdb", type: "file" },
    ]);
    const { app, commands } = fakeApp({ "proj/w.pdb": [1] });
    activateBuilder(app as never, null, browser as never, null, null);
    expect(commands.get(CommandIDs.openInBuilder)!.isVisible!({})).toBe(true);
    await app.commands.execute(CommandIDs.openInBuilder);
    expect(openStructureFile.mock.calls[0][0].name).toBe("w.pdb");
  });

  it("says so when nothing is selected, and when a file cannot be read", async () => {
    const warning = vi.spyOn(apputils.Notification, "warning");
    const error = vi.spyOn(apputils.Notification, "error");
    const { app, commands } = fakeApp();
    activateBuilder(app as never, null, fakeBrowser() as never, null, null);
    expect(commands.get(CommandIDs.openInBuilder)!.isVisible!({})).toBe(false);
    await app.commands.execute(CommandIDs.openInBuilder);
    expect(warning).toHaveBeenCalledTimes(1);
    await app.commands.execute(CommandIDs.openInBuilder, { path: "gone.pdb" });
    expect(error.mock.calls[0][0]).toBe("Megane Builder could not read gone.pdb: not found");
    expect(openStructureFile).not.toHaveBeenCalled();
  });

  it("the sidebar follows the file browser and opens through the commands", async () => {
    const browser = fakeBrowser();
    const { app } = fakeApp({ "proj/w.pdb": [1] });
    activateBuilder(app as never, null, browser as never, null, null);
    const sidebar = app.shell.add.mock.calls[0][0] as BuilderSidebar;
    const refresh = vi.spyOn(sidebar, "refresh");
    browser.fire();
    expect(refresh).toHaveBeenCalledTimes(2);
    sidebar.node
      .querySelector<HTMLButtonElement>('[data-testid="megane-builder-sidebar-file"]')!
      .click();
    expect(app.commands.execute).toHaveBeenCalledWith(CommandIDs.openInBuilder, {
      path: "proj/w.pdb",
    });
    sidebar.node
      .querySelector<HTMLButtonElement>('[data-testid="megane-builder-sidebar-open"]')!
      .click();
    expect(app.commands.execute).toHaveBeenCalledWith(CommandIDs.openBuilder);
  });
});

describe("meganeIcon", () => {
  it("is a LabIcon of the Megane logo", () => {
    expect(MEGANE_ICON_SVG).toContain("<svg");
    expect(MEGANE_ICON_SVG).toContain('fill="#2aa590"');
    expect((meganeIcon as unknown as { name: string }).name).toBe("megane-jupyterlab:megane");
  });
});
