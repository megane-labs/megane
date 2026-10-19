// @vitest-environment node
// Node's File implements arrayBuffer(); jsdom's does not.
import { describe, it, expect } from "vitest";
import {
  PROGRESSIVE_HEAD_BYTES,
  PROGRESSIVE_TAIL_BYTES,
  assembleFileBytes,
  receiveProgressiveFile,
  shouldDeliverProgressively,
} from "@/hosts/progressiveFile";

const toFile = (bytes: Uint8Array<ArrayBuffer>, name: string) => new File([bytes], name);

describe("shouldDeliverProgressively", () => {
  it("splits only files larger than head + tail", () => {
    const edge = PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES;
    expect(shouldDeliverProgressively(edge)).toBe(false);
    expect(shouldDeliverProgressively(edge + 1)).toBe(true);
  });
});

describe("assembleFileBytes", () => {
  it("puts head, middle and tail back in order", () => {
    const bytes = assembleFileBytes(
      6,
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
      new Uint8Array([6]),
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("refuses pieces that do not add up to the file", () => {
    expect(() =>
      assembleFileBytes(9, new Uint8Array(2), new Uint8Array(3), new Uint8Array(1)),
    ).toThrow(/do not add up/);
  });
});

describe("receiveProgressiveFile", () => {
  it("exposes head and tail at once and the whole file once the middle arrives", async () => {
    const head = new Uint8Array([1, 2]);
    const tail = new Uint8Array([5]);
    const { file, deliverMiddle } = receiveProgressiveFile("a.xyz", 5, head, tail, toFile);
    expect(file).toMatchObject({ name: "a.xyz", size: 5, head, tail });
    deliverMiddle(new Uint8Array([3, 4]));
    const whole = await file.file;
    expect(whole.name).toBe("a.xyz");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("rejects the whole file when the middle does not fit", async () => {
    const { file, deliverMiddle } = receiveProgressiveFile(
      "a.xyz",
      5,
      new Uint8Array(2),
      new Uint8Array(1),
      toFile,
    );
    deliverMiddle(new Uint8Array(7));
    await expect(file.file).rejects.toThrow(/do not add up/);
  });

  it("rejects the whole file on fail", async () => {
    const { file, fail } = receiveProgressiveFile(
      "a.xyz",
      5,
      new Uint8Array(2),
      new Uint8Array(1),
      toFile,
    );
    fail(new Error("host closed"));
    await expect(file.file).rejects.toThrow("host closed");
  });
});
