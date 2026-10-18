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
  addClass(_className: string): void {
    void _className;
  }
  protected onAfterAttach(_msg?: unknown): void {
    void _msg;
  }
  dispose(): void {
    this.isDisposed = true;
  }
}
