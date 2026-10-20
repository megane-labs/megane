/**
 * The bulk crystal form on its own: the lattice constant it suggests per
 * prototype (and the user's own value it keeps), the species named by their
 * role, and the inline check of the element symbols.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  BulkForm,
  siteRoles,
  speciesProblem,
  suggestedLatticeConstant,
} from "@/builder/crystal/BulkForm";

const type = (id: string, value: string) =>
  fireEvent.change(screen.getByTestId(id), { target: { value } });
const value = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value;
const choose = (structure: string) => type("builder-bulk-structure", structure);

afterEach(() => cleanup());

describe("BulkForm", () => {
  it("suggests each prototype's lattice constant and keeps one the user typed", () => {
    const onCreate = vi.fn();
    render(<BulkForm onCreate={onCreate} onError={vi.fn()} />);
    expect(value("builder-bulk-a")).toBe("3.61");
    choose("bcc");
    expect(value("builder-bulk-a")).toBe("2.87");
    type("builder-bulk-a", "3.3");
    choose("diamond");
    expect(value("builder-bulk-a")).toBe("5.43");
    // Back to bcc: the user's 3.3 is still there.
    choose("bcc");
    expect(value("builder-bulk-a")).toBe("3.3");
    // A prototype without an example gets a fallback.
    choose("sc");
    expect(value("builder-bulk-a")).toBe("3.35");
    // An emptied field is not "typed": switching back suggests again.
    type("builder-bulk-a", "");
    expect(screen.getByTestId("builder-bulk-problem").textContent).toBe("a needs a number.");
    choose("fcc");
    choose("sc");
    expect(value("builder-bulk-a")).toBe("3.35");
    // An example's value is a suggestion: it replaces what was typed for that prototype.
    choose("bcc");
    type("builder-bulk-example", "W (bcc)");
    expect(value("builder-bulk-a")).toBe("3.16");
    choose("fcc");
    choose("bcc");
    expect(value("builder-bulk-a")).toBe("2.87");
  });

  it("names the sites by role and flags a symbol that is not an element as it is typed", () => {
    const onCreate = vi.fn();
    const onError = vi.fn();
    render(<BulkForm onCreate={onCreate} onError={onError} createLabel="Go" />);
    expect(screen.getByTestId("builder-bulk-role-0").textContent).toBe("Element");
    choose("perovskite");
    expect([0, 1, 2].map((k) => screen.getByTestId(`builder-bulk-role-${k}`).textContent)).toEqual([
      "A (A-site cation)",
      "B (B-site cation)",
      "X (anion ×3)",
    ]);
    expect(screen.queryByTestId("builder-bulk-problem")).toBeNull();
    type("builder-bulk-element-1", "Qq");
    expect(screen.getByTestId("builder-bulk-problem").textContent).toBe(
      'Species B: "Qq" is not an element symbol.',
    );
    expect(screen.getByTestId("builder-bulk-element-1").getAttribute("aria-invalid")).toBe("true");
    type("builder-bulk-element-1", "ti");
    expect(screen.queryByTestId("builder-bulk-problem")).toBeNull();
    expect(screen.getByTestId("builder-bulk-create").textContent).toBe("Go");
    // Create still names a blank species; with all three it builds the spec.
    type("builder-bulk-element-0", "Sr");
    fireEvent.click(screen.getByTestId("builder-bulk-create"));
    expect(onError).toHaveBeenCalledWith("Enter an element for species X (the anion ×3).");
    type("builder-bulk-element-2", "O");
    fireEvent.click(screen.getByTestId("builder-bulk-create"));
    expect(onCreate).toHaveBeenCalledWith({
      structure: "perovskite",
      elements: [38, 22, 8],
      a: 3.905,
    });
  });

  it("helpers: suggestions, roles and symbol checks", () => {
    expect(suggestedLatticeConstant("rocksalt")).toBe(5.64);
    expect(suggestedLatticeConstant("sc")).toBe(3.35);
    expect(siteRoles("rocksalt")).toEqual(["cation", "anion"]);
    expect(siteRoles("fluorite")).toEqual(["cation", "anion ×2"]);
    expect(siteRoles("hcp")).toEqual(["element"]);
    expect(speciesProblem(0, "")).toBeNull();
    expect(speciesProblem(0, "fe")).toBeNull();
    expect(speciesProblem(2, "Xx")).toBe('Species X: "Xx" is not an element symbol.');
  });
});
