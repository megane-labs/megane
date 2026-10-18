/** The megane icon (a pair of glasses — *megane* in Japanese) for the sidebar tab, the launcher and the Builder tab. */

import { LabIcon } from "@jupyterlab/ui-components";

export const MEGANE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">' +
  '<g class="jp-icon3" fill="none" stroke="#616161" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="6.5" cy="13" r="4"/><circle cx="17.5" cy="13" r="4"/>' +
  '<path d="M10.5 12.2c.9-.8 2.1-.8 3 0"/><path d="M2.5 12 1.5 8.5"/><path d="M21.5 12l1-3.5"/>' +
  "</g></svg>";

export const meganeIcon = new LabIcon({
  name: "megane-jupyterlab:megane",
  svgstr: MEGANE_ICON_SVG,
});
