import { describe, it, expect, vi } from "vitest";

import {
  fallbackFactoryName,
  handOffToOtherEditor,
  TEXT_EDITOR_FACTORY,
} from "../../../jupyterlab-megane/src/handOff";
import {
  FACTORY_NAME,
  FACTORY_NAME_BINARY,
  FACTORY_NAME_PIPELINE,
} from "../../../jupyterlab-megane/src/filetypes";

function registry(names: string[]) {
  return {
    preferredWidgetFactories: vi.fn((_path: string) => names.map((name) => ({ name }))),
  } as unknown as Parameters<typeof fallbackFactoryName>[0];
}

describe("fallbackFactoryName", () => {
  it("skips Megane's own factories for the next preferred one", () => {
    const reg = registry([FACTORY_NAME, FACTORY_NAME_BINARY, "CSVTable", "Editor"]);
    expect(fallbackFactoryName(reg, "data.csv")).toBe("CSVTable");
  });

  it("falls back to the text editor when only Megane wants the file", () => {
    const reg = registry([FACTORY_NAME, FACTORY_NAME_PIPELINE]);
    expect(fallbackFactoryName(reg, "data.peptide")).toBe(TEXT_EDITOR_FACTORY);
  });
});

describe("handOffToOtherEditor", () => {
  it("opens the file with the fallback factory, then closes Megane's widget", async () => {
    const order: string[] = [];
    const app = {
      docRegistry: registry([FACTORY_NAME, "JSON", "Editor"]),
      commands: {
        execute: vi.fn(async () => {
          order.push("open");
        }),
      },
    };
    const widget = { context: { path: "runs/data.json" }, close: vi.fn(() => order.push("close")) };

    await handOffToOtherEditor(app, widget);

    expect(app.commands.execute).toHaveBeenCalledWith("docmanager:open", {
      path: "runs/data.json",
      factory: "JSON",
    });
    expect(order).toEqual(["open", "close"]);
  });
});
