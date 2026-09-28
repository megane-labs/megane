import { describe, it, expect } from "vitest";
import { PDB_MODEL_SNIFF_BYTES, pdbHeadMayHaveModels, pdbMayHaveModels } from "@/parsers/pdbModels";

const ATOM = "ATOM      1  N   MET A   1      27.340  24.430   2.614  1.00  9.67           N";
const HETATM = "HETATM    1  O   HOH A   1      -0.125   0.451   0.232  1.00  0.00           O";

describe("pdbHeadMayHaveModels", () => {
  it("is false for a single-model file (first coordinate record, no MODEL)", () => {
    expect(pdbHeadMayHaveModels(`CRYST1   10.000   10.000   10.000\n${ATOM}\n${ATOM}\n`)).toBe(
      false,
    );
    expect(pdbHeadMayHaveModels(`${HETATM}\nEND\n`)).toBe(false);
  });

  it("is true when a MODEL record precedes the first coordinate record", () => {
    expect(pdbHeadMayHaveModels(`REMARK x\nMODEL        1\n${ATOM}\nENDMDL\n`)).toBe(true);
    // Bare "MODEL" and CRLF line endings, as the Rust parser accepts them.
    expect(pdbHeadMayHaveModels(`MODEL\r\n${ATOM}\r\n`)).toBe(true);
  });

  it("ignores MODEL records that only appear after the first model's atoms", () => {
    // Not a valid multi-model layout; the first model is read without MODEL.
    expect(pdbHeadMayHaveModels(`${ATOM}\nMODEL        2\n${ATOM}\n`)).toBe(false);
  });

  it("does not mistake look-alike record names", () => {
    expect(pdbHeadMayHaveModels(`MODELS  bogus\n${ATOM}\n`)).toBe(false);
    expect(pdbHeadMayHaveModels(`REMARK MODEL 1\n${ATOM}\n`)).toBe(false);
  });

  it("cannot rule models out when the head holds no coordinate record", () => {
    expect(pdbHeadMayHaveModels("HEADER    PROTEIN\nREMARK   2 RESOLUTION.\n")).toBe(true);
    expect(pdbHeadMayHaveModels("")).toBe(true);
  });
});

/** A File stand-in (jsdom's Blob has no `.text()`) that records what was read. */
function textFile(content: string) {
  const reads: [number, number][] = [];
  const file = {
    size: content.length,
    slice: (start = 0, end = content.length) => {
      reads.push([start, end]);
      return { text: async () => content.slice(start, end) };
    },
  } as unknown as Blob;
  return { file, reads };
}

describe("pdbMayHaveModels", () => {
  const model = `MODEL        1\n${ATOM}\n`;
  const header = "REMARK\n".repeat(Math.ceil(PDB_MODEL_SNIFF_BYTES / 7) + 1);

  it("reads only the head of the file", async () => {
    const { file, reads } = textFile(`${ATOM}\n${header}${model}`);
    expect(await pdbMayHaveModels(file)).toBe(false);
    expect(reads).toEqual([[0, PDB_MODEL_SNIFF_BYTES]]);
  });

  it("finds a MODEL record in the head", async () => {
    expect(await pdbMayHaveModels(textFile(`${model}${header}`).file)).toBe(true);
  });

  it("keeps a file whose header outgrows the head on the lazy path", async () => {
    // The MODEL record sits past the sniffed head, so it cannot be ruled out.
    expect(await pdbMayHaveModels(textFile(`${header}${model}`).file)).toBe(true);
  });
});
