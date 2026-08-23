/**
 * Unit tests for the JCAMP-DX parser facade.
 *
 * The real WASM module is replaced with a mock (jsdom cannot run the
 * wasm-bindgen bundle), so these exercise the main-thread path the component
 * tests stub out: sniff → lazy WASM init → `parse_jcampdx` → `SpectrumData`.
 * The decoding itself is covered by the Rust tests in `megane-core`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { calls, wasmMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const wasmMock = {
    default: async () => {
      calls.push("init");
    },
    parse_jcampdx: (text: string) => {
      calls.push("parse_jcampdx");
      if (text.includes("BROKEN")) throw new Error("no data block");
      return {
        title: "Ethanol",
        data_type: "INFRARED SPECTRUM",
        x_units: "1/CM",
        y_units: "TRANSMITTANCE",
        n_points: 3,
        warnings: text.includes("BLOCKS")
          ? "compound file contains 1 additional spectrum block(s); only the first readable spectrum is shown"
          : "",
        x: () => new Float64Array([400, 430, 460]),
        y: () => new Float64Array([100, 80, 95]),
      };
    },
  };
  return { calls, wasmMock };
});

vi.mock("../../../crates/megane-wasm/pkg", () => wasmMock);

import { parseSpectrum, isJcampDx, isSpectrumFileName, SPECTRUM_ACCEPT } from "@/parsers/spectrum";

const JCAMP = "##TITLE=Ethanol\n##JCAMP-DX=4.24\n##XYDATA=(X++(Y..Y))\n400 100 80 95\n##END=\n";
const OPENDX = "object 1 class gridpositions counts 2 2 2\norigin 0 0 0\n";

describe("parseSpectrum", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("maps the WASM result onto SpectrumData", async () => {
    const spectrum = await parseSpectrum(JCAMP);
    expect(spectrum.type).toBe("spectrum");
    expect(spectrum.title).toBe("Ethanol");
    expect(spectrum.dataType).toBe("INFRARED SPECTRUM");
    expect(spectrum.xUnits).toBe("1/CM");
    expect(spectrum.yUnits).toBe("TRANSMITTANCE");
    expect(Array.from(spectrum.x)).toEqual([400, 430, 460]);
    expect(Array.from(spectrum.y)).toEqual([100, 80, 95]);
    expect(calls).toContain("parse_jcampdx");
  });

  it("surfaces parser warnings via console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await parseSpectrum(JCAMP.replace("##JCAMP-DX=4.24", "##JCAMP-DX=4.24\n##BLOCKS=2"));
    expect(warn).toHaveBeenCalledWith(
      "[megane parser] compound file contains 1 additional spectrum block(s); only the first readable spectrum is shown",
    );
    warn.mockRestore();
  });

  it("stays silent for a clean single-spectrum parse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await parseSpectrum(JCAMP);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("initialises the WASM module only once across calls", async () => {
    await parseSpectrum(JCAMP);
    await parseSpectrum(JCAMP);
    // The module promise is memoised, so `default()` runs at most once for the
    // whole test file (an earlier test may already have paid for it).
    expect(calls.filter((c) => c === "init").length).toBeLessThanOrEqual(1);
  });

  it("rejects an OpenDX grid before touching WASM, pointing at the other node", async () => {
    await expect(parseSpectrum(OPENDX)).rejects.toThrow(/not a JCAMP-DX spectrum/);
    await expect(parseSpectrum(OPENDX)).rejects.toThrow(/Load Volumetric/);
    expect(calls).not.toContain("parse_jcampdx");
  });

  it("propagates a decode failure from WASM", async () => {
    await expect(parseSpectrum(`${JCAMP}BROKEN\n`)).rejects.toThrow(/no data block/);
  });
});

describe("spectrum file dispatch", () => {
  it("offers the same extensions in the accept list and the drop guard", () => {
    expect(SPECTRUM_ACCEPT).toBe(".jdx,.jcamp,.dx");
    for (const ext of SPECTRUM_ACCEPT.split(",")) {
      expect(isSpectrumFileName(`sample${ext}`)).toBe(true);
    }
  });

  it("sniffs past leading whitespace and comment lines", () => {
    expect(isJcampDx("\n\n##TITLE=x\n")).toBe(true);
    expect(isJcampDx("$$ exported by megane\n##JCAMP-DX=4.24\n")).toBe(true);
    // `##JCAMPDX=` and `## JCAMP - DX =` are both seen in the wild.
    expect(isJcampDx("##JCAMPDX=5.01\n")).toBe(true);
    expect(isJcampDx("## JCAMP - DX = 5.01\n")).toBe(true);
  });

  it("does not mistake an OpenDX grid or a structure file for a spectrum", () => {
    expect(isJcampDx(OPENDX)).toBe(false);
    expect(isJcampDx("ATOM      1  N   MET A   1\n")).toBe(false);
    expect(isJcampDx("")).toBe(false);
  });
});
