// Test-only stub for `@jupyterlab/apputils`. See sibling jupyterlab-coreutils.ts.

export class WidgetTracker<T = unknown> {
  add(_widget: T): Promise<void> {
    void _widget;
    return Promise.resolve();
  }
  save(_widget: T): Promise<void> {
    void _widget;
    return Promise.resolve();
  }
}

export const ICommandPalette = { name: "ICommandPalette" };
export type ICommandPalette = { addItem(item: unknown): unknown };
export const Notification = {
  warning: (_message: string, _options?: unknown): string => "",
  error: (_message: string, _options?: unknown): string => "",
};
export const Dialog = {
  cancelButton: (options?: unknown) => ({ accept: false, ...(options as object) }),
  warnButton: (options?: unknown) => ({ accept: true, ...(options as object) }),
};
export function showDialog(_options?: unknown): Promise<{ button: { accept: boolean } }> {
  return Promise.resolve({ button: { accept: false } });
}
export const InputDialog = {
  getText: (_options?: unknown): Promise<{ button: { accept: boolean }; value: string | null }> =>
    Promise.resolve({ button: { accept: false }, value: null }),
};
