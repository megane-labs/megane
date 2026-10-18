/**
 * Stand-in for `KetcherEditor` in bundles that leave the sketcher out (the
 * Jupyter widget: a single-file bundle, where Ketcher and its WASM engine
 * would add ~20 MB to every notebook). Rendering it throws, which the sketch
 * dialog's load boundary turns into its *Paste MOL* fallback, so molecules
 * still reach the library as MOL / SDF text (embedded in 3D by RDKit).
 */

export const KETCHER_UNAVAILABLE =
  "the sketcher is not part of the Jupyter widget; draw in the megane web app, VS Code or JupyterLab";

export default function KetcherUnavailable(): never {
  throw new Error(KETCHER_UNAVAILABLE);
}
