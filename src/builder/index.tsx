/**
 * Entry point of megane Builder (`builder.html`): the structure editor,
 * built as its own Vite entry beside the viewer.
 */

import { initAnalytics } from "../analytics";
import { mountBuilder } from "./mount";
import "../styles/megane.css";

initAnalytics("builder");

mountBuilder(document.getElementById("root")!);
