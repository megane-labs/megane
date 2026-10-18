/**
 * megane Builder's file I/O in JupyterLab: files come from and go back to the
 * Jupyter server's contents (the file browser's tree), not the browser's
 * downloads.
 */

import type { Contents } from "@jupyterlab/services";
import type { BuilderSaveRequest } from "@megane/builder/host";

/**
 * File extensions the file browser offers to open in the Builder: the
 * structure formats with coordinates (the list the VS Code extension's
 * Explorer entry uses). VASP's POSCAR / CONTCAR / XDATCAR go by name.
 */
export const BUILDER_EXTENSIONS = [
  "pdb",
  "gro",
  "xyz",
  "extxyz",
  "jxyz",
  "mol",
  "sdf",
  "mol2",
  "cif",
  "mmcif",
  "data",
  "lammps",
  "lammpstrj",
  "dump",
  "trj",
  "traj",
  "vasp",
  "molden",
  "cml",
  "xsf",
  "axsf",
  "c3xml",
  "xodydata",
  "odydata",
  "magres",
  "gamess",
  "phonon",
];
const BUILDER_NAME = new RegExp(
  `(\\.(${BUILDER_EXTENSIONS.join("|")})$)|^(POSCAR|CONTCAR|XDATCAR)`,
  "i",
);

/** The last segment of a contents path. */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The directory part of a contents path ("" at the root). */
export function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** Whether the Builder offers to open the file at `path`. */
export function isBuilderPath(path: string): boolean {
  return BUILDER_NAME.test(basename(path));
}

/** Read a file from the server as a `File`, bytes intact (binary formats such as ASE `.traj` included). */
export async function readContentsFile(
  contents: Pick<Contents.IManager, "get">,
  path: string,
): Promise<File> {
  const model = await contents.get(path, { type: "file", format: "base64", content: true });
  const raw = atob(String(model.content ?? "").replace(/\s/g, ""));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new File([bytes], basename(path));
}

/** The questions Save asks: where to write, and whether to replace an existing file. */
export interface SavePrompts {
  /** Resolves to the path to write (relative to the server root), or null to cancel. */
  path(defaultPath: string): Promise<string | null>;
  /** Resolves to whether `path`, which exists, may be replaced. */
  overwrite(path: string): Promise<boolean>;
}

/**
 * Save a Builder file into the server's contents, beside `dir`: ask for the
 * path, confirm before replacing a file, write it. Resolves to the notice for
 * the Builder (`Saved dir/name.xyz`), or null when cancelled.
 */
export async function saveToContents(
  contents: Pick<Contents.IManager, "get" | "save">,
  file: BuilderSaveRequest,
  dir: string,
  prompts: SavePrompts,
): Promise<string | null> {
  const suggested = dir ? `${dir}/${file.name}` : file.name;
  const path = (await prompts.path(suggested))?.trim().replace(/^\/+/, "");
  if (!path) return null;
  let exists = true;
  try {
    await contents.get(path, { content: false });
  } catch {
    exists = false;
  }
  if (exists && !(await prompts.overwrite(path))) return null;
  await contents.save(path, { type: "file", format: "text", content: file.text });
  return `Saved ${path}`;
}
