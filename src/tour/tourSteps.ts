/**
 * Step definitions for the megane user tours.
 *
 * Two separate tours are exposed:
 *
 * - `buildTourSteps()`            — short overview of the whole viewer.
 *                                   The Pipeline step links into the deeper
 *                                   pipeline-assembly tutorial via a button
 *                                   (handled by MeganeTour.startTour's
 *                                   `onPopoverRender`).
 * - `buildPipelineTutorialSteps()` — focused walk-through of how a pipeline
 *                                    is wired up: load → connect → toggle
 *                                    → viewport.
 *
 * Targets reference DOM nodes that already exist in the shared MeganeViewer:
 *  - [data-tour-anchor="viewport"]   — invisible region inside Viewport.tsx
 *                                      so we highlight just the canvas area,
 *                                      not the whole view (which would also
 *                                      include the Pipeline panel)
 *  - [data-testid="panel-pipeline"]  — CollapsiblePanel for PipelineEditor
 *  - [data-testid="pipeline-editor-templates"] — Templates button
 *  - [data-testid="pipeline-editor-tutorial"]  — Tutorial button (launches
 *                                                the pipeline tutorial)
 *  - [data-testid="pipeline-node-load_structure"] — Load Structure node card
 *  - [data-testid="pipeline-node-add_bond"]      — Add Bond node card
 *  - [data-testid="pipeline-node-viewport"]      — Viewport node card
 *
 * The Load Structure / Add Bond / Viewport node anchors are present in every
 * default pipeline (web default, demo, and the vscode empty graph all seed
 * these three node types), so the assembly walk-through works on every host.
 *
 * Centered (un-anchored) modal steps have no `element`; driver.js renders them
 * centred so they work on every host even when no anchor is present.
 */
import type { DriveStep } from "driver.js";
import packageJson from "../../package.json";

const APP_VERSION = (packageJson as { version: string }).version;

const REPO_URL = "https://github.com/megane-labs/megane";
const DOCS_URL = "https://megane-labs.github.io/megane/";
const AUTHOR_GITHUB_URL = "https://github.com/hodakamori";
const AUTHOR_LINKEDIN_URL = "https://www.linkedin.com/in/hodaka-mori-146b61ba/";

const ICON_GITHUB = `
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="currentColor" d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1.17-.02-2.13-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.16 1.17a10.99 10.99 0 0 1 5.76 0c2.2-1.48 3.16-1.17 3.16-1.17.62 1.57.23 2.73.11 3.02.74.8 1.18 1.82 1.18 3.07 0 4.4-2.7 5.36-5.27 5.65.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.55C20.71 21.4 24 17.1 24 12.02 24 5.74 18.77.5 12.5.5h-.5Z"/>
  </svg>`;

const ICON_DOCS = `
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 1 4 18.5v-14Z"/>
    <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>
    <path d="M8 7h8"/>
    <path d="M8 11h6"/>
  </svg>`;

const ICON_LINKEDIN = `
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.37V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.26 2.37 4.26 5.45v6.29ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0Z"/>
  </svg>`;

const ICON_ARROW = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="5" y1="12" x2="19" y2="12"/>
    <polyline points="13 6 19 12 13 18"/>
  </svg>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkCard(opts: {
  href: string;
  icon: string;
  title: string;
  subtitle: string;
  hostLabel: string;
}): string {
  const safeHref = escapeHtml(opts.href);
  return `
    <a class="megane-tour-link-card" href="${safeHref}" target="_blank" rel="noopener noreferrer">
      <span class="megane-tour-link-card-icon">${opts.icon}</span>
      <span class="megane-tour-link-card-body">
        <span class="megane-tour-link-card-title">${escapeHtml(opts.title)}</span>
        <span class="megane-tour-link-card-subtitle">${escapeHtml(opts.subtitle)}</span>
        <span class="megane-tour-link-card-host">${escapeHtml(opts.hostLabel)}</span>
      </span>
      <span class="megane-tour-link-card-arrow">${ICON_ARROW}</span>
    </a>`;
}

function welcomeDescription(): string {
  return `
    <div class="megane-tour-welcome">
      <div class="megane-tour-welcome-header">
        <span class="megane-tour-welcome-name">megane</span>
        <span class="megane-tour-welcome-version">v${escapeHtml(APP_VERSION)}</span>
      </div>
      <p class="megane-tour-welcome-tagline">Spectacles for atomistic data.</p>
      <p class="megane-tour-welcome-blurb">
        A fast, beautiful molecular viewer — render millions of atoms at 60fps,
        build visual pipelines, and embed it in Jupyter, the browser, React, or VSCode.
      </p>
      <div class="megane-tour-welcome-author">
        <span class="megane-tour-welcome-author-label">Built by hodakamori</span>
        <span class="megane-tour-welcome-author-icons">
          <a class="megane-tour-icon-link" href="${escapeHtml(AUTHOR_GITHUB_URL)}" target="_blank" rel="noopener noreferrer" aria-label="Author on GitHub" title="GitHub">${ICON_GITHUB}</a>
          <a class="megane-tour-icon-link" href="${escapeHtml(AUTHOR_LINKEDIN_URL)}" target="_blank" rel="noopener noreferrer" aria-label="Author on LinkedIn" title="LinkedIn">${ICON_LINKEDIN}</a>
        </span>
      </div>
    </div>`;
}

export function buildTourSteps(): DriveStep[] {
  return [
    {
      popover: {
        title: "Welcome",
        description: welcomeDescription(),
        side: "over",
        align: "center",
      },
    },
    {
      element: '[data-tour-anchor="viewport"]',
      popover: {
        title: "3D Viewport",
        description:
          "Atoms, bonds, cells and trajectories all draw here. Use the mouse to orbit, pan, and zoom around your structure.",
        side: "right",
        align: "center",
      },
    },
    {
      element: '[data-testid="panel-pipeline"]',
      popover: {
        title: "Pipeline",
        description:
          "Build a rendering pipeline by connecting nodes: load files, apply bonds, attach trajectories, and choose a visual style.",
        side: "left",
        align: "start",
      },
    },
    {
      element: '[data-testid="pipeline-editor-tutorial"]',
      popover: {
        title: "Want a deeper walk-through?",
        description:
          "Click the highlighted <strong>Tutorial</strong> button anytime for a step-by-step guide to building a pipeline — load → connect → toggle → viewport.",
        side: "bottom",
        align: "end",
      },
    },
    {
      element: '[data-testid="pipeline-editor-templates"]',
      popover: {
        title: "Templates",
        description:
          "Pick a starter pipeline (molecule, solid, streaming) to see a working setup in one click.",
        side: "bottom",
        align: "end",
      },
    },
    {
      popover: {
        title: "Mouse Controls",
        description: `
          <ul class="megane-tour-keys">
            <li><span class="megane-tour-key">Left&nbsp;drag</span> Rotate the camera</li>
            <li><span class="megane-tour-key">Right&nbsp;drag</span> Pan</li>
            <li><span class="megane-tour-key">Wheel</span> Zoom</li>
            <li><span class="megane-tour-key">Right&nbsp;click</span> Pick an atom for measurement</li>
          </ul>`,
        side: "over",
        align: "center",
      },
    },
    {
      popover: {
        title: "Learn More",
        description: `
          <p class="megane-tour-links-intro">Explore the source code or read the full documentation.</p>
          <div class="megane-tour-links">
            ${linkCard({
              href: REPO_URL,
              icon: ICON_GITHUB,
              title: "GitHub repository",
              subtitle: "Source, issues and releases",
              hostLabel: "github.com",
            })}
            ${linkCard({
              href: DOCS_URL,
              icon: ICON_DOCS,
              title: "Documentation",
              subtitle: "Guides, examples and API reference",
              hostLabel: "github.com",
            })}
          </div>`,
        side: "over",
        align: "center",
      },
    },
  ];
}

/**
 * Pipeline-assembly tutorial: a focused, deeper walk-through that the main
 * tour links to. Designed to be launched independently from the main tour
 * (see `MeganeTour.startPipelineTutorial`).
 *
 * All node anchors target nodes seeded by every default pipeline variant
 * (web default, demo, vscode empty), so the tutorial works on every host.
 */
export function buildPipelineTutorialSteps(): DriveStep[] {
  return [
    {
      popover: {
        title: "Pipeline tutorial",
        description: `
          <p class="megane-tour-paragraph">Let's see how a megane pipeline is wired up.</p>
          <p class="megane-tour-paragraph">In four short steps we'll go from a structure file all the way to what you see in the 3D viewport — <strong>load → connect → toggle → viewport</strong>.</p>`,
        side: "over",
        align: "center",
      },
    },
    {
      element: '[data-testid="pipeline-node-load_structure"]',
      popover: {
        title: "1. Load a structure",
        description:
          "Every pipeline starts here. The <strong>Load Structure</strong> node reads a structure file (PDB, CIF, GRO, XYZ, MOL, LAMMPS data, …) and emits typed outputs — particles, optional cell, optional trajectory — that downstream nodes can consume.",
        side: "left",
        align: "start",
      },
    },
    {
      element: '[data-testid="pipeline-node-add_bond"]',
      popover: {
        title: "2. Connect outputs to inputs",
        description:
          "Drag from a node's <strong>bottom handle (output)</strong> to the next node's <strong>top handle (input)</strong> to route data downstream. Handle colors mark the data type — particle is blue, bond is amber, trajectory is cyan, cell is green — and only matching types snap together, so the graph stays valid by construction.",
        side: "left",
        align: "start",
      },
    },
    {
      element: '[data-testid="pipeline-node-add_bond"]',
      popover: {
        title: "3. Active nodes light up",
        description:
          "Each node has a <strong>toggle switch</strong> in its header and a colored stripe down its left edge marking its category. Enabled nodes show in full color and contribute to the render; toggling one off greys it out (50% opacity) and skips its branch — handy for A/B comparing styles or muting a heavy step. A red or amber badge appears whenever a node has errors or warnings.",
        side: "left",
        align: "start",
      },
    },
    {
      element: '[data-testid="pipeline-node-viewport"]',
      popover: {
        title: "4. Everything ends in the Viewport",
        description:
          "The <strong>Viewport</strong> node is the terminus of every pipeline. Whatever you wire into its inputs — particles, bonds, trajectories, overlays — becomes what you see in the 3D viewport on the left. If nothing reaches it, nothing renders. Each pipeline keeps exactly one Viewport, so it is never deletable.",
        side: "left",
        align: "start",
      },
    },
  ];
}
