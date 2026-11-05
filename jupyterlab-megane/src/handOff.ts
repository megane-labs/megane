/**
 * Step aside for a file Megane should not have opened.
 *
 * The LAMMPS file types claim `data.*` / `dump.*` names by `pattern`
 * (`withLammpsPrefixPatterns` in `filetypes.ts`), and a leading `data.` is
 * common outside LAMMPS. When the DocWidget finds such a file is not LAMMPS
 * (`isForeignLammpsPrefixFile`), it hands the file back to the editor
 * JupyterLab would have opened it in without Megane — the same rule the VS Code
 * extension applies.
 */

import type { DocumentRegistry } from "@jupyterlab/docregistry";
import { FACTORY_NAME, FACTORY_NAME_BINARY, FACTORY_NAME_PIPELINE } from "./filetypes";

const MEGANE_FACTORIES: ReadonlySet<string> = new Set([
  FACTORY_NAME,
  FACTORY_NAME_BINARY,
  FACTORY_NAME_PIPELINE,
]);

/** JupyterLab's text editor factory, the last resort for any file. */
export const TEXT_EDITOR_FACTORY = "Editor";

/**
 * The widget factory `path` opens with when Megane steps aside: the first of
 * the registry's preferred factories that is not Megane's, else the text editor.
 */
export function fallbackFactoryName(
  registry: Pick<DocumentRegistry, "preferredWidgetFactories">,
  path: string,
): string {
  const factory = registry
    .preferredWidgetFactories(path)
    .find((f) => !MEGANE_FACTORIES.has(f.name));
  return factory?.name ?? TEXT_EDITOR_FACTORY;
}

export interface HandOffApp {
  docRegistry: Pick<DocumentRegistry, "preferredWidgetFactories">;
  commands: { execute(command: string, args?: Record<string, unknown>): Promise<unknown> };
}

/** Reopen `widget`'s file in the editor JupyterLab would use without Megane, then close `widget`. */
export async function handOffToOtherEditor(
  app: HandOffApp,
  widget: { context: { path: string }; close(): void },
): Promise<void> {
  const path = widget.context.path;
  await app.commands.execute("docmanager:open", {
    path,
    factory: fallbackFactoryName(app.docRegistry, path),
  });
  widget.close();
}
