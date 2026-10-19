// Test-only stub for `@lumino/widgets`.
// Provides minimal Widget shape so jupyterlab-megane/src/frameStatusBar.ts
// resolves at transform time. Tests can use vi.mock() to override behavior.

export class Widget {
  node: HTMLElement;
  id = "";
  isDisposed = false;
  title: { label: string; caption: string; closable: boolean; icon: unknown } = {
    label: "",
    caption: "",
    closable: false,
    icon: null,
  };
  constructor() {
    this.node = document.createElement("div");
  }
  addClass(className: string): void {
    this.node.classList.add(className);
  }
  isAttached = false;
  protected onAfterAttach(_msg?: unknown): void {
    void _msg;
  }
  /** As in Lumino: close() sends a close-request, whose default handler only detaches. */
  close(): void {
    this.onCloseRequest();
  }
  protected onCloseRequest(_msg?: unknown): void {
    void _msg;
    this.isAttached = false;
  }
  dispose(): void {
    this.isDisposed = true;
  }
}
