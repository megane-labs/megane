import { describe, it, expect, afterEach } from "vitest";
import { decodeBase64 } from "@/utils/base64";

type WithFromBase64 = typeof Uint8Array & { fromBase64?: (s: string) => Uint8Array };
const ctor = Uint8Array as WithFromBase64;
const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");

afterEach(() => {
  if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
  else delete ctor.fromBase64;
});

const BYTES = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
const B64 = Buffer.from(BYTES).toString("base64");

describe("decodeBase64", () => {
  it("decodes with an indexed loop when the engine has no Uint8Array.fromBase64", () => {
    delete ctor.fromBase64;
    expect(decodeBase64(B64)).toEqual(BYTES);
  });

  it("accepts line-wrapped base64 on the fallback path", () => {
    delete ctor.fromBase64;
    const wrapped = `${B64.slice(0, 4)}\n${B64.slice(4)}\r\n`;
    expect(decodeBase64(wrapped)).toEqual(BYTES);
  });

  it("uses the native Uint8Array.fromBase64 when present", () => {
    let calledWith: string | null = null;
    ctor.fromBase64 = function (this: unknown, s: string) {
      expect(this).toBe(Uint8Array);
      calledWith = s;
      return new Uint8Array([9, 9]);
    };
    expect(decodeBase64("AAAA")).toEqual(new Uint8Array([9, 9]));
    expect(calledWith).toBe("AAAA");
  });

  it("falls back to atob when the native decoder rejects the input", () => {
    ctor.fromBase64 = () => {
      throw new SyntaxError("bad padding");
    };
    expect(decodeBase64(B64)).toEqual(BYTES);
  });

  it("returns an empty array for an empty string", () => {
    delete ctor.fromBase64;
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
  });
});
