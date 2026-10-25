import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Timeline } from "@/components/Timeline";

const defaultProps = {
  currentFrame: 0,
  totalFrames: 100,
  playing: false,
  fps: 30,
  speedMultiplier: 1,
  loopStart: 0,
  loopEnd: 99,
  onSeek: vi.fn(),
  onPlayPause: vi.fn(),
  onFpsChange: vi.fn(),
  onSpeedChange: vi.fn(),
  onLoopRangeChange: vi.fn(),
  onStepBackward: vi.fn(),
  onStepForward: vi.fn(),
};

describe("Timeline", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("returns null when totalFrames <= 1", () => {
    const { container } = render(<Timeline {...defaultProps} totalFrames={1} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when totalFrames is 0", () => {
    const { container } = render(<Timeline {...defaultProps} totalFrames={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders play button when not playing", () => {
    render(<Timeline {...defaultProps} playing={false} />);
    const button = screen.getByTitle("Play");
    expect(button).toBeInTheDocument();
  });

  it("renders pause button when playing", () => {
    render(<Timeline {...defaultProps} playing={true} />);
    const button = screen.getByTitle("Pause");
    expect(button).toBeInTheDocument();
  });

  it("displays frame counter", () => {
    render(<Timeline {...defaultProps} currentFrame={49} totalFrames={100} />);
    expect(screen.getByText("50 / 100")).toBeInTheDocument();
  });

  it("calls onPlayPause when play button is clicked", () => {
    const onPlayPause = vi.fn();
    render(<Timeline {...defaultProps} onPlayPause={onPlayPause} />);
    fireEvent.click(screen.getByTitle("Play"));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("renders seek slider with correct range", () => {
    render(<Timeline {...defaultProps} currentFrame={10} totalFrames={50} loopEnd={49} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "49");
    expect(slider).toHaveValue("10");
  });

  it("calls onSeek when slider value changes", () => {
    const onSeek = vi.fn();
    render(<Timeline {...defaultProps} onSeek={onSeek} />);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "42" } });
    expect(onSeek).toHaveBeenCalledWith(42);
  });

  it("renders FPS selector with options", () => {
    render(<Timeline {...defaultProps} fps={30} />);
    const select = screen.getByTestId("playback-fps");
    expect(select).toHaveValue("30");
  });

  it("renders step backward button", () => {
    render(<Timeline {...defaultProps} />);
    expect(screen.getByTestId("step-backward")).toBeInTheDocument();
  });

  it("renders step forward button", () => {
    render(<Timeline {...defaultProps} />);
    expect(screen.getByTestId("step-forward")).toBeInTheDocument();
  });

  it("calls onStepBackward when step-backward is clicked", () => {
    const onStepBackward = vi.fn();
    render(<Timeline {...defaultProps} onStepBackward={onStepBackward} />);
    fireEvent.click(screen.getByTestId("step-backward"));
    expect(onStepBackward).toHaveBeenCalledTimes(1);
  });

  it("calls onStepForward when step-forward is clicked", () => {
    const onStepForward = vi.fn();
    render(<Timeline {...defaultProps} onStepForward={onStepForward} />);
    fireEvent.click(screen.getByTestId("step-forward"));
    expect(onStepForward).toHaveBeenCalledTimes(1);
  });

  it("renders speed selector with correct value", () => {
    render(<Timeline {...defaultProps} speedMultiplier={2} />);
    const select = screen.getByTestId("playback-speed");
    expect(select).toHaveValue("2");
  });

  it("calls onSpeedChange when speed selector changes", () => {
    const onSpeedChange = vi.fn();
    render(<Timeline {...defaultProps} onSpeedChange={onSpeedChange} />);
    fireEvent.change(screen.getByTestId("playback-speed"), { target: { value: "0.5" } });
    expect(onSpeedChange).toHaveBeenCalledWith(0.5);
  });

  it("renders loop start input with correct value", () => {
    render(<Timeline {...defaultProps} loopStart={5} />);
    const input = screen.getByTestId("loop-start");
    expect(input).toHaveValue(5);
  });

  it("renders loop end input with correct value", () => {
    render(<Timeline {...defaultProps} loopEnd={80} />);
    const input = screen.getByTestId("loop-end");
    expect(input).toHaveValue(80);
  });

  it("calls onLoopRangeChange when loop-start changes", () => {
    const onLoopRangeChange = vi.fn();
    render(
      <Timeline
        {...defaultProps}
        loopStart={0}
        loopEnd={99}
        onLoopRangeChange={onLoopRangeChange}
      />,
    );
    fireEvent.change(screen.getByTestId("loop-start"), { target: { value: "10" } });
    expect(onLoopRangeChange).toHaveBeenCalledWith(10, 99);
  });

  it("calls onLoopRangeChange when loop-end changes", () => {
    const onLoopRangeChange = vi.fn();
    render(
      <Timeline
        {...defaultProps}
        loopStart={0}
        loopEnd={99}
        onLoopRangeChange={onLoopRangeChange}
      />,
    );
    fireEvent.change(screen.getByTestId("loop-end"), { target: { value: "50" } });
    expect(onLoopRangeChange).toHaveBeenCalledWith(0, 50);
  });

  it("calls onStepBackward on ArrowLeft key press", () => {
    const onStepBackward = vi.fn();
    render(<Timeline {...defaultProps} onStepBackward={onStepBackward} />);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(onStepBackward).toHaveBeenCalledTimes(1);
  });

  it("calls onStepForward on ArrowRight key press", () => {
    const onStepForward = vi.fn();
    render(<Timeline {...defaultProps} onStepForward={onStepForward} />);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onStepForward).toHaveBeenCalledTimes(1);
  });

  it("does not call step on ArrowLeft when focus is in an input", () => {
    const onStepBackward = vi.fn();
    render(<Timeline {...defaultProps} onStepBackward={onStepBackward} />);
    const input = screen.getByTestId("loop-start");
    fireEvent.keyDown(input, { key: "ArrowLeft", target: input });
    expect(onStepBackward).not.toHaveBeenCalled();
  });

  describe("arrow-key scoping", () => {
    /** A viewer root (focusable, as every host's is) with a Timeline drawn over it. */
    function renderViewer(props: Partial<typeof defaultProps> = {}) {
      const onStepBackward = vi.fn();
      const onStepForward = vi.fn();
      const utils = render(
        <div tabIndex={-1}>
          <Timeline
            {...defaultProps}
            onStepBackward={onStepBackward}
            onStepForward={onStepForward}
            {...props}
          />
        </div>,
      );
      const root = utils.container.firstChild as HTMLElement;
      return { root, onStepBackward, onStepForward };
    }

    afterEach(() => {
      document.body.querySelectorAll("[data-outside]").forEach((n) => n.remove());
    });

    function outsideEditor(): HTMLElement {
      // A notebook cell: CodeMirror 6 edits a contenteditable <div>, not a <textarea>.
      const editor = document.createElement("div");
      editor.setAttribute("data-outside", "");
      editor.contentEditable = "true";
      editor.tabIndex = 0;
      document.body.appendChild(editor);
      return editor;
    }

    it("ignores arrows typed into a contenteditable editor elsewhere on the page", () => {
      const { onStepBackward, onStepForward } = renderViewer();
      const editor = outsideEditor();
      editor.focus();
      // jsdom does not implement isContentEditable; the browser reports it.
      Object.defineProperty(editor, "isContentEditable", { value: true });
      expect(fireEvent.keyDown(editor, { key: "ArrowLeft" })).toBe(true);
      fireEvent.keyDown(editor, { key: "ArrowRight" });
      expect(onStepBackward).not.toHaveBeenCalled();
      expect(onStepForward).not.toHaveBeenCalled();
    });

    it("ignores arrows typed into a contenteditable field inside the viewer", () => {
      const { root, onStepForward } = renderViewer();
      const field = document.createElement("div");
      field.contentEditable = "true";
      field.tabIndex = 0;
      root.appendChild(field);
      field.focus();
      Object.defineProperty(field, "isContentEditable", { value: true });
      expect(fireEvent.keyDown(field, { key: "ArrowRight" })).toBe(true);
      expect(onStepForward).not.toHaveBeenCalled();
    });

    it("ignores arrows while focus sits on another element outside the viewer", () => {
      const { onStepForward } = renderViewer();
      const outside = document.createElement("button");
      outside.setAttribute("data-outside", "");
      document.body.appendChild(outside);
      outside.focus();
      // Dispatched on document (not the button) so only the focus check can reject it.
      expect(fireEvent.keyDown(document, { key: "ArrowRight" })).toBe(true);
      expect(onStepForward).not.toHaveBeenCalled();
    });

    it("steps when focus is inside the viewer", () => {
      const { root, onStepBackward, onStepForward } = renderViewer();
      root.focus();
      expect(document.activeElement).toBe(root);
      expect(fireEvent.keyDown(root, { key: "ArrowRight" })).toBe(false);
      fireEvent.keyDown(root, { key: "ArrowLeft" });
      expect(onStepForward).toHaveBeenCalledTimes(1);
      expect(onStepBackward).toHaveBeenCalledTimes(1);
    });

    it("steps only the viewer that holds focus when a page hosts two", () => {
      const a = renderViewer();
      const b = renderViewer();
      b.root.focus();
      fireEvent.keyDown(b.root, { key: "ArrowRight" });
      expect(b.onStepForward).toHaveBeenCalledTimes(1);
      expect(a.onStepForward).not.toHaveBeenCalled();
    });

    it.each([
      ["altKey", "Alt+← is the browser's Back"],
      ["ctrlKey", "Ctrl+← moves by word"],
      ["metaKey", "Cmd+← moves to the line start"],
      ["shiftKey", "Shift+← extends a selection"],
    ])("leaves a %s arrow to the browser (%s)", (modifier) => {
      const { root, onStepBackward } = renderViewer();
      root.focus();
      // Not cancelled: the browser still performs its own action.
      expect(fireEvent.keyDown(root, { key: "ArrowLeft", [modifier]: true })).toBe(true);
      expect(onStepBackward).not.toHaveBeenCalled();
    });

    it("ignores an arrow another handler already consumed", () => {
      const { root, onStepForward } = renderViewer();
      root.focus();
      const consume = (e: Event) => e.preventDefault();
      root.addEventListener("keydown", consume);
      fireEvent.keyDown(root, { key: "ArrowRight" });
      root.removeEventListener("keydown", consume);
      expect(onStepForward).not.toHaveBeenCalled();
    });

    it("ignores other keys and does not cancel them", () => {
      const { root, onStepBackward, onStepForward } = renderViewer();
      root.focus();
      expect(fireEvent.keyDown(root, { key: "ArrowUp" })).toBe(true);
      expect(onStepBackward).not.toHaveBeenCalled();
      expect(onStepForward).not.toHaveBeenCalled();
    });
  });
});
