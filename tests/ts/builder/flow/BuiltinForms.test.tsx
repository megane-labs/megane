/**
 * The settings of Flow mode's built-in blocks, edited in the pane under the
 * graph: each control writes the block's params in the Flow store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BuilderProvider, createBuilderStores, type BuilderStores } from "@/builder/BuilderStores";
import { FlowProperties } from "@/builder/flow/FlowProperties";
import { defaultBuiltinParams, type BuiltinType } from "@/builder/flow/builtins";
import type { FlowParams } from "@/builder/flow/types";
import { fakeDeps } from "./helpers";

let stores: BuilderStores;
beforeEach(() => {
  stores = createBuilderStores();
});

/** The pane with one selected block of `type`; returns a reader for its params. */
function edit(type: BuiltinType, patch: Partial<FlowParams> = {}) {
  const id = stores.flow
    .getState()
    .addNode({ ...defaultBuiltinParams(type), ...patch } as FlowParams);
  render(
    <BuilderProvider stores={stores}>
      <FlowProperties deps={fakeDeps()} height="50%" serverOpen={false} onCloseServer={vi.fn()} />
    </BuilderProvider>,
  );
  return () => stores.flow.getState().nodes.find((n) => n.id === id)!.data.params as never;
}

const change = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe("CrystalForm", () => {
  it("fills every field from an example and edits them one by one", () => {
    const params = edit("crystal");
    change("builder-flow-crystal-example", "ZnO (wurtzite)");
    expect(params()).toMatchObject({
      structure: "wurtzite",
      elements: ["Zn", "O", ""],
      a: 3.25,
      cubic: false,
    });
    expect(screen.queryByTestId("builder-flow-crystal-cubic")).toBeNull();
    change("builder-flow-crystal-covera", "1.7");
    expect(params()).toMatchObject({ covera: 1.7 });
    change("builder-flow-crystal-example", "");
    expect(params()).toMatchObject({ structure: "wurtzite" });

    change("builder-flow-crystal-structure", "fcc");
    expect(screen.queryByTestId("builder-flow-crystal-covera")).toBeNull();
    expect(screen.queryByTestId("builder-flow-crystal-element-1")).toBeNull();
    change("builder-flow-crystal-element-0", "Ni");
    change("builder-flow-crystal-a", "3.52");
    fireEvent.click(screen.getByTestId("builder-flow-crystal-cubic"));
    expect(params()).toMatchObject({ elements: ["Ni", "O", ""], a: 3.52, cubic: true });
    change("builder-flow-crystal-a", "");
    expect(Number.isNaN((params() as { a: number }).a)).toBe(true);
    expect((screen.getByTestId("builder-flow-crystal-a") as HTMLInputElement).value).toBe("");
  });

  it("keeps c/a when an example has none", () => {
    const params = edit("crystal", { covera: 1.5 } as Partial<FlowParams>);
    change("builder-flow-crystal-example", "Cu (fcc)");
    expect(params()).toMatchObject({ covera: 1.5, cubic: true });
  });
});

describe("PolymerForm", () => {
  it("picks a preset, edits the unit, and says what the chain will be", () => {
    const params = edit("polymer");
    expect(screen.getByTestId("builder-flow-polymer-check").dataset.ok).toBe("true");
    expect(screen.getByTestId("builder-flow-polymer-check").textContent).toContain(
      "20 heavy atoms",
    );
    change("builder-flow-polymer-preset", "ps");
    expect(params()).toMatchObject({ repeatUnit: "*CC(c1ccccc1)*", name: "PS" });
    change("builder-flow-polymer-preset", "nope");
    expect(params()).toMatchObject({ name: "PS" });

    change("builder-flow-polymer-unit", "*CC(C)(C)*");
    expect((screen.getByTestId("builder-flow-polymer-preset") as HTMLSelectElement).value).toBe("");
    change("builder-flow-polymer-length", "5");
    change("builder-flow-polymer-name", "PIB");
    expect(params()).toMatchObject({ repeatUnit: "*CC(C)(C)*", length: 5, name: "PIB" });

    change("builder-flow-polymer-unit", "CC");
    const check = screen.getByTestId("builder-flow-polymer-check");
    expect(check.dataset.ok).toBe("false");
    expect(check.textContent).toContain("one * at the start");
  });
});

describe("crystal transform forms", () => {
  it("edits a supercell's repeats", () => {
    const params = edit("supercell");
    change("builder-flow-supercell-repeat-1", "4");
    expect(params()).toMatchObject({ repeat: [2, 4, 2] });
    expect(screen.getByLabelText("Repeats along c")).toBeTruthy();
  });

  it("edits a slab's Miller indices, layers, vacuum and repeats", () => {
    const params = edit("slab");
    change("builder-flow-slab-miller-2", "0");
    change("builder-flow-slab-layers", "6");
    change("builder-flow-slab-vacuum", "12.5");
    change("builder-flow-slab-repeat-0", "3");
    expect(params()).toMatchObject({ miller: [1, 1, 0], layers: 6, vacuum: 12.5, repeat: [3, 2] });
  });

  it("edits how molecules sit on a surface", () => {
    const params = edit("adsorb");
    change("builder-flow-adsorb-height", "3");
    change("builder-flow-adsorb-grid-1", "2");
    expect(params()).toMatchObject({ height: 3, grid: [1, 2] });
  });
});
