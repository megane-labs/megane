import { Widget } from "@lumino/widgets";
import type { IStatusBar } from "@jupyterlab/statusbar";
import type { JupyterFrontEnd } from "@jupyterlab/application";
import type { WidgetTracker } from "@jupyterlab/apputils";
import type { IDocumentWidget } from "@jupyterlab/docregistry";

/** A viewer tab's content: the structure viewer and the Pipeline Viewer both qualify. */
interface FrameSource extends Widget {
  subscribeFrameChange(cb: (frame: number) => void): () => void;
}

type ViewerTracker = WidgetTracker<IDocumentWidget<FrameSource>>;

/**
 * Show the frame of the current Megane tab, structure viewer or Pipeline
 * Viewer alike, in the status bar.
 */
export function setupFrameStatusBar(
  trackers: readonly ViewerTracker[],
  statusBar: IStatusBar,
  shell?: JupyterFrontEnd.IShell,
): void {
  const item = new Widget();
  item.addClass("jp-megane-frame-status");
  item.node.textContent = "";

  let shown: IDocumentWidget<FrameSource> | null = null;
  let currentUnsub: (() => void) | null = null;

  const follow = (widget: IDocumentWidget<FrameSource> | null): void => {
    if (widget === shown) return;
    currentUnsub?.();
    currentUnsub = null;
    shown = widget;
    item.node.textContent = "";
    if (widget) {
      currentUnsub = widget.content.subscribeFrameChange((frame) => {
        item.node.textContent = `Frame ${frame}`;
      });
    }
  };

  for (const tracker of trackers) {
    tracker.currentChanged.connect((_tracker, widget) => {
      // A kind whose last tab closed hands over to the other kind's tab.
      follow(widget ?? trackers.map((t) => t.currentWidget).find((w) => w !== null) ?? null);
    });
  }

  // Each tracker only knows its own kind: refocusing a structure tab after a
  // pipeline tab leaves the structure tracker's current widget unchanged and
  // emits nothing, so the shell's focus decides between the kinds.
  shell?.currentChanged?.connect((_shell, { newValue }) => {
    for (const tracker of trackers) {
      if (newValue && tracker.has(newValue)) {
        follow(newValue as IDocumentWidget<FrameSource>);
        return;
      }
    }
  });

  statusBar.registerStatusItem("megane:frame-counter", {
    item,
    align: "right",
    rank: 100,
    isActive: () => trackers.some((tracker) => tracker.currentWidget !== null),
  });
}
