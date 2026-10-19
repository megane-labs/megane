import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Contents } from "@jupyterlab/services";

vi.mock("../../../jupyterlab-megane/src/MeganeDocWidget", () => ({
  // Use a regular function (not an arrow) so the mock can be invoked with `new`.
  // vitest 4 calls a mock's implementation as a constructor under `new`, and
  // arrow functions are not constructable.
  MeganeReactView: vi.fn().mockImplementation(function (
    context: unknown,
    contents: unknown,
    request: unknown,
  ) {
    return { kind: "structure", context, contents, request };
  }),
}));

vi.mock("../../../jupyterlab-megane/src/MeganePipelineDocWidget", () => ({
  MeganePipelineReactView: vi.fn().mockImplementation(function (
    context: unknown,
    contents: unknown,
    request: unknown,
  ) {
    return { kind: "pipeline", context, contents, request };
  }),
}));

vi.mock("@jupyterlab/docregistry", () => {
  class ABCWidgetFactory {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  }
  const DocumentWidget = vi.fn().mockImplementation(function (opts: {
    content: unknown;
    context: unknown;
  }) {
    return {
      content: opts.content,
      context: opts.context,
      title: { iconClass: "" },
    };
  });
  return { ABCWidgetFactory, DocumentWidget };
});

import { MeganeReactView } from "../../../jupyterlab-megane/src/MeganeDocWidget";
import { MeganePipelineReactView } from "../../../jupyterlab-megane/src/MeganePipelineDocWidget";
import { DocumentWidget } from "@jupyterlab/docregistry";
import { MeganeDocFactory, MeganePipelineDocFactory } from "../../../jupyterlab-megane/src/factory";

type Exposed<R = unknown> = { createNewWidget: (ctx: unknown) => R };

const factoryOptions = { name: "test", fileTypes: [] };
const fakeContext = { id: "fake-context" };
const fakeContents = {} as unknown as Contents.IManager;
const fakeRequest = async (_url: string) => new Response();

beforeEach(() => {
  vi.mocked(MeganeReactView).mockClear();
  vi.mocked(MeganePipelineReactView).mockClear();
  vi.mocked(DocumentWidget).mockClear();
});

describe("MeganeDocFactory", () => {
  it("constructs without throwing when given ABCWidgetFactory options and contents", () => {
    expect(() => new MeganeDocFactory(factoryOptions, fakeContents, fakeRequest)).not.toThrow();
  });

  it("createNewWidget instantiates MeganeReactView with context and contents", () => {
    const factory = new MeganeDocFactory(factoryOptions, fakeContents, fakeRequest);
    (factory as unknown as Exposed).createNewWidget(fakeContext);

    expect(MeganeReactView).toHaveBeenCalledTimes(1);
    expect(MeganeReactView).toHaveBeenCalledWith(fakeContext, fakeContents, fakeRequest);
  });

  it("createNewWidget returns a DocumentWidget with the megane iconClass", () => {
    const factory = new MeganeDocFactory(factoryOptions, fakeContents, fakeRequest);
    const widget = (
      factory as unknown as Exposed<{ title: { iconClass: string } }>
    ).createNewWidget(fakeContext);

    expect(DocumentWidget).toHaveBeenCalledTimes(1);
    expect(widget.title.iconClass).toBe("jp-MaterialIcon jp-FileIcon");
  });
});

describe("MeganePipelineDocFactory", () => {
  it("stores the contents manager passed to the constructor", () => {
    const factory = new MeganePipelineDocFactory(factoryOptions, fakeContents, fakeRequest);
    (factory as unknown as Exposed).createNewWidget(fakeContext);

    expect(MeganePipelineReactView).toHaveBeenCalledTimes(1);
    expect(MeganePipelineReactView).toHaveBeenCalledWith(fakeContext, fakeContents, fakeRequest);
  });

  it("createNewWidget passes both context and contents through to MeganePipelineReactView", () => {
    const customContents = { distinct: true } as unknown as Contents.IManager;
    const factory = new MeganePipelineDocFactory(factoryOptions, customContents, fakeRequest);
    (factory as unknown as Exposed).createNewWidget(fakeContext);

    expect(MeganePipelineReactView).toHaveBeenCalledWith(fakeContext, customContents, fakeRequest);
  });

  it("createNewWidget returns a DocumentWidget with the megane iconClass", () => {
    const factory = new MeganePipelineDocFactory(factoryOptions, fakeContents, fakeRequest);
    const widget = (
      factory as unknown as Exposed<{ title: { iconClass: string } }>
    ).createNewWidget(fakeContext);

    expect(DocumentWidget).toHaveBeenCalledTimes(1);
    expect(widget.title.iconClass).toBe("jp-MaterialIcon jp-FileIcon");
  });
});

describe("MeganeDocFactory vs MeganePipelineDocFactory", () => {
  it("produce wrappers around different widget classes", () => {
    const structureFactory = new MeganeDocFactory(factoryOptions, fakeContents, fakeRequest);
    const pipelineFactory = new MeganePipelineDocFactory(factoryOptions, fakeContents, fakeRequest);

    (structureFactory as unknown as Exposed).createNewWidget(fakeContext);
    (pipelineFactory as unknown as Exposed).createNewWidget(fakeContext);

    expect(MeganeReactView).toHaveBeenCalledTimes(1);
    expect(MeganePipelineReactView).toHaveBeenCalledTimes(1);
    expect(DocumentWidget).toHaveBeenCalledTimes(2);
  });
});
