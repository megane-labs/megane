import { describe, it, expect } from "vitest";
import { labelsFromText, packLabels, splitLabels, unpackLabels } from "@/parsers/labels";

describe("splitLabels", () => {
  it.each([
    "",
    "HOH1",
    "HOH1\nHOH1\nHOH1\nHOH2\nHOH2",
    "a\n",
    "\n\n",
    "ALA1\nALA1\n\nGLY2\nGLY2\nALA1",
    "ABCDEFGHIJKLMNOP\nABCDEFGHIJKLMNOP\nABCDEFGHIJKLMNOQ",
  ])("matches String#split for %j", (text) => {
    expect(splitLabels(text)).toEqual(text.split("\n"));
  });

  it("does not mistake a longer neighbour for a repeat", () => {
    expect(splitLabels("HOH1\nHOH10\nHOH1")).toEqual(["HOH1", "HOH10", "HOH1"]);
  });
});

describe("packLabels / unpackLabels", () => {
  it("posts the parsed text instead of the array and splits it back", () => {
    const text = "HOH1\nHOH1\nNA2";
    const labels = labelsFromText(text);
    const packed = packLabels({ labels, other: 1 });
    expect(packed.labels).toBeNull();
    expect(packed.labelsText).toBe(text);
    expect(packed.other).toBe(1);

    const wire = structuredClone(packed);
    const back = unpackLabels(wire);
    expect(back.labels).toEqual(["HOH1", "HOH1", "NA2"]);
    expect("labelsText" in back).toBe(false);
  });

  it("joins labels that were not split from a text", () => {
    const packed = packLabels({ labels: ["A", "B"] });
    expect(packed.labelsText).toBe("A\nB");
  });

  it("leaves results without labels alone", () => {
    const r = { labels: null };
    expect(packLabels(r)).toBe(r);
    expect(unpackLabels(r)).toBe(r);
  });
});
