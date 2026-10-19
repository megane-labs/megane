import { describe, it, expect } from "vitest";
import {
  MeganeRawModel,
  MeganeRawModelFactory,
  RAW_MODEL_NAME,
  READ_ONLY_MESSAGE,
} from "../../../jupyterlab-megane/src/rawModel";

describe("MeganeRawModelFactory", () => {
  it("asks the document context for metadata only (no content)", () => {
    const factory = new MeganeRawModelFactory();
    expect(factory.name).toBe(RAW_MODEL_NAME);
    expect(factory.contentType).toBe("file");
    expect(factory.fileFormat).toBeNull();
    expect(factory.collaborative).toBe(false);
    expect(factory.preferredLanguage("a.pdb")).toBe("");
  });

  it("creates read-only raw models and can be disposed", () => {
    const factory = new MeganeRawModelFactory();
    const model = factory.createNew();
    expect(model).toBeInstanceOf(MeganeRawModel);
    expect(model.readOnly).toBe(true);
    expect(factory.isDisposed).toBe(false);
    factory.dispose();
    expect(factory.isDisposed).toBe(true);
  });
});

describe("MeganeRawModel", () => {
  it("drops content an older JupyterLab still sends", () => {
    const model = new MeganeRawModel();
    expect(() => model.fromString("ATOM ...")).not.toThrow();
  });

  it("refuses to serialize, so a Save cannot write an empty file over the data", () => {
    const model = new MeganeRawModel();
    expect(() => model.toString()).toThrow(READ_ONLY_MESSAGE);
    expect(() => model.toJSON()).toThrow(READ_ONLY_MESSAGE);
  });
});
