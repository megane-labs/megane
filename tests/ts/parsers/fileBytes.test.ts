// @vitest-environment node
// Node's Blob/File implement text()/arrayBuffer() on slices; jsdom's do not.
import { describe, it, expect, vi } from "vitest";
import { fileFromBytes, readBlobBuffer, readBlobText } from "@/parsers/fileBytes";

const encode = (s: string) => new TextEncoder().encode(s);

describe("fileFromBytes", () => {
  it("builds a real File with the bytes, name and options", async () => {
    const file = fileFromBytes(encode("ATOM\n"), "a.pdb", { type: "chemical/x-pdb" });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("a.pdb");
    expect(file.type).toBe("chemical/x-pdb");
    expect(file.size).toBe(5);
    expect(await file.text()).toBe("ATOM\n");
  });
});

describe("reads of a resident File", () => {
  it("never touch the Blob API", async () => {
    const file = fileFromBytes(encode("HEAD\nBODY\nTAIL\n"), "m.xyz");
    const text = vi.spyOn(file, "text");
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const slice = vi.spyOn(file, "slice");
    expect(await readBlobText(file)).toBe("HEAD\nBODY\nTAIL\n");
    expect(await readBlobText(file, 5, 10)).toBe("BODY\n");
    expect(await readBlobText(file, 10)).toBe("TAIL\n");
    expect(new Uint8Array(await readBlobBuffer(file, 0, 4))).toEqual(encode("HEAD"));
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
  });

  it("hand out a copy the caller may transfer without detaching the resident bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = fileFromBytes(bytes, "w.traj");
    const buffer = await readBlobBuffer(file);
    expect(buffer).not.toBe(bytes.buffer);
    expect(new Uint8Array(buffer)).toEqual(bytes);
    structuredClone(buffer, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0);
    expect(new Uint8Array(await readBlobBuffer(file))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("copy only the requested range of a view into a larger buffer", async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const file = fileFromBytes(backing.subarray(2, 5), "v.traj");
    expect(new Uint8Array(await readBlobBuffer(file))).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await readBlobBuffer(file, 1))).toEqual(new Uint8Array([2, 3]));
  });
});

describe("reads of any other Blob", () => {
  it("go through the Blob API as before", async () => {
    const file = new File(["ABCDEF"], "x.pdb");
    expect(await readBlobText(file)).toBe("ABCDEF");
    expect(await readBlobText(file, 2, 4)).toBe("CD");
    expect(new Uint8Array(await readBlobBuffer(file))).toEqual(encode("ABCDEF"));
    expect(new Uint8Array(await readBlobBuffer(file, 4))).toEqual(encode("EF"));
  });

  it("do not pick up the bytes of a slice of a resident File", async () => {
    const file = fileFromBytes(encode("0123456789"), "s.xyz");
    const part = file.slice(2, 5);
    expect(await readBlobText(part)).toBe("234");
  });
});

describe("isResident", () => {
  it("is true only for files built from bytes the host holds", async () => {
    const { fileFromBytes, isResident } = await import("@/parsers/fileBytes");
    expect(isResident(fileFromBytes(new Uint8Array([1]), "a.pdb"))).toBe(true);
    expect(isResident(new File(["x"], "b.pdb"))).toBe(false);
  });
});
