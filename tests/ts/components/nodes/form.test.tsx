import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Field, FileDrop, Section, SliderField } from "@/components/nodes/form";

afterEach(() => cleanup());

describe("node form kit", () => {
  it("makes a plain Field a label, so its text names the control", () => {
    render(
      <Field label="Iso level">
        <input type="number" />
      </Field>,
    );
    expect(screen.getByLabelText("Iso level").tagName).toBe("INPUT");
  });

  it("makes a group Field a labelled group, not a label that would click its first button", () => {
    const first = vi.fn();
    render(
      <Field label="Source" group>
        <button type="button" onClick={first}>
          File
        </button>
        <button type="button">VDW</button>
      </Field>,
    );
    const group = screen.getByRole("group", { name: "Source" });
    expect(group.tagName).toBe("DIV");
    fireEvent.click(screen.getByText("Source"));
    expect(first).not.toHaveBeenCalled();
  });

  it("prints a SliderField's formatted value and reports changes as numbers", () => {
    const onChange = vi.fn();
    render(
      <SliderField
        label="Opacity"
        testId="s"
        min={0}
        max={1}
        step={0.05}
        value={0.25}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("25%")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Opacity"), { target: { value: "0.5" } });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it("titles a Section", () => {
    render(
      <Section title="Atoms">
        <input aria-label="q" />
      </Section>,
    );
    expect(screen.getByText("Atoms")).toBeInTheDocument();
  });

  it("shows the empty text until a file is open, and opens the dialog from its button", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <FileDrop
        fileName=""
        emptyText="No structure loaded"
        buttonLabel="Load structure..."
        nameTestId="name"
        onPick={onPick}
        fileInput={<input type="file" data-testid="file" style={{ display: "none" }} />}
      />,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("No structure loaded");
    fireEvent.click(screen.getByText("Load structure..."));
    expect(onPick).toHaveBeenCalledTimes(1);
    // The hidden input sits beside the button, inside the drop box.
    expect(
      screen.getByText("Load structure...").parentElement!.contains(screen.getByTestId("file")),
    ).toBe(true);

    rerender(
      <FileDrop
        fileName="caffeine.pdb"
        emptyText="No structure loaded"
        buttonLabel="Load structure..."
        nameTestId="name"
        onPick={onPick}
      >
        <span>3 edits</span>
      </FileDrop>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("caffeine.pdb");
    expect(screen.getByText("3 edits")).toBeInTheDocument();
  });
});
