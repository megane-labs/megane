// Test-only stub for `@jupyterlab/ui-components`.
// Provides minimal ReactWidget shape so jupyterlab-megane/src/MeganeDocWidget.tsx
// resolves at transform time. Tests can use vi.mock() to override behaviour.

export class ReactWidget {
  addClass(_className: string): void {}
  protected render(): null {
    return null;
  }
}

export class LabIcon {
  name: string;
  svgstr: string;
  constructor(options: { name: string; svgstr: string }) {
    this.name = options.name;
    this.svgstr = options.svgstr;
  }
}
