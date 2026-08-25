import React, { useEffect, useState } from "react";
import BrowserOnly from "@docusaurus/BrowserOnly";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type { HeroMode } from "../components/HeroViewer";
import styles from "./index.module.css";

const DEMO_URL = "https://megane-labs.github.io/megane/app/";
const GITHUB_URL = "https://github.com/megane-labs/megane";

const MODES: { id: HeroMode; label: string }[] = [
  { id: "molecular", label: "Caffeine · water" },
  { id: "protein", label: "Protein" },
  { id: "perovskite", label: "Perovskite" },
  { id: "quartz", label: "Quartz" },
];

/** How long each structure is shown before the hero cycles to the next. */
const CYCLE_MS = 7000;

function Hero({
  mode,
  setMode,
}: {
  mode: HeroMode;
  setMode: (m: HeroMode) => void;
}) {
  return (
    <header className={styles.hero}>
      <BrowserOnly>
        {() => {
          const HeroViewer = require("../components/HeroViewer").default;
          return <HeroViewer mode={mode} />;
        }}
      </BrowserOnly>
      <div className={styles.heroVignette} aria-hidden="true" />

      <div className={styles.heroContent}>
        <span className={styles.heroBadge}>◉ live in your browser · WASM</span>
        <h1 className={styles.heroTitle}>
          Spectacles for
          <br />
          atomistic data.
        </h1>
        <p className={styles.heroLead}>
          A million atoms at 60fps, right here on the page. No install to look —
          install when you&rsquo;re ready to build.
        </p>
        <div className={styles.heroActions}>
          <Link className={styles.btnPrimary} to="/getting-started">
            Get Started
          </Link>
          <Link className={styles.btnSecondary} href={DEMO_URL}>
            Open full demo →
          </Link>
        </div>
      </div>

      <div className={styles.heroModes}>
        <span className={styles.heroModesLabel}>NOW VIEWING</span>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`${styles.modePill} ${
              mode === m.id ? styles.modePillActive : ""
            }`}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </header>
  );
}

const ENVIRONMENTS = [
  {
    title: "Jupyter widget",
    install: "pip install megane",
    isCommand: true,
    description:
      "Interactive widget inside Jupyter notebooks. Build pipelines in Python, display structures inline.",
    href: "/guide/jupyter",
  },
  {
    title: "React component",
    install: "npm install megane-viewer",
    isCommand: true,
    description:
      "Drop <PipelineViewer /> into any React app. Build pipelines with the TypeScript builder API.",
    href: "/guide/web",
  },
  {
    title: "Standalone web app",
    install: "megane serve ./structures",
    isCommand: true,
    description:
      "Serve local structure files and view them instantly in the browser. No code needed.",
    href: "/guide/cli",
  },
  {
    title: "VS Code extension",
    install: "Install from Marketplace",
    isCommand: false,
    description:
      "Open .pdb, .gro, .xyz, .mol, .cif files directly in VS Code with the megane extension.",
    href: "/guide/vscode",
  },
];

function EnvironmentPicker() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <span className={styles.eyebrow}>START IN YOUR ENVIRONMENT</span>
        <h2 className={styles.sectionTitle}>Runs everywhere you work</h2>
        <div className={styles.envGrid}>
          {ENVIRONMENTS.map((e) => (
            <Link key={e.href} className={styles.envCard} to={e.href}>
              <h3 className={styles.envTitle}>{e.title}</h3>
              <code
                className={`${styles.envInstall} ${
                  e.isCommand ? "" : styles.envInstallPlain
                }`}
              >
                {e.install}
              </code>
              <p className={styles.envDesc}>{e.description}</p>
              <span className={styles.envLink}>{e.title} →</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

const CAPABILITIES = [
  {
    title: "1M+ atoms at 60fps",
    body: "Billboard impostor rendering draws every atom as a shaded quad in a single instanced draw call — from small molecules to massive complexes. megane serve streams multi-GB XTC trajectories over WebSocket without loading them into memory.",
  },
  {
    title: "One Rust core, every host",
    body: "PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, LAMMPS data and dump, VASP, Molden, XCrySDen, CML, XTC, ASE .traj and more are parsed in Rust, compiled to both PyO3 and WASM. Parse once, run anywhere — Jupyter, browser, React, VS Code, JupyterLab.",
  },
  {
    title: "Visual pipeline editor",
    body: "Wire 19 node types across 5 categories to load, filter, style and overlay — no code required. 9 typed data channels flow through color-coded edges; only matching types connect. Pipelines serialize to JSON to save and share.",
  },
  {
    title: "Embed & integrate",
    body: "Control the viewer from Plotly via ipywidgets events, embed in MDX / Next.js docs, and react to frame_change, selection_change and measurement events. MoleculeRenderer is a plain Three.js class — mount it in Vue, Svelte, or vanilla JS.",
  },
];

function Capabilities() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <span className={styles.eyebrow}>WHAT YOU GET</span>
        <h2 className={styles.sectionTitle}>Built for real atomistic data</h2>
        <div className={styles.capGrid}>
          {CAPABILITIES.map((c) => (
            <div key={c.title} className={styles.capCard}>
              <h3 className={styles.capTitle}>{c.title}</h3>
              <p className={styles.capBody}>{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaSection() {
  return (
    <section className={styles.cta}>
      <div className={styles.ctaInner}>
        <div>
          <div className={styles.ctaTitle}>Ready to see it move?</div>
          <div className={styles.ctaSubtitle}>
            Open the live demo — a million atoms, right in your browser.
          </div>
        </div>
        <div className={styles.ctaActions}>
          <Link className={styles.ctaPrimary} href={DEMO_URL}>
            Launch demo →
          </Link>
          <Link className={styles.ctaSecondary} href={GITHUB_URL}>
            GitHub
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): React.JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const [mode, setMode] = useState<HeroMode>("molecular");

  // Force the dark navbar/footer chrome on the landing page regardless of the
  // docs color mode (see html.sp-landing rules in _chrome.css).
  useEffect(() => {
    document.documentElement.classList.add("sp-landing");
    return () => document.documentElement.classList.remove("sp-landing");
  }, []);

  // Auto-cycle the hero structure over time (Caffeine · water ⇄ Perovskite).
  // Keying on `mode` restarts the timer on every change, so a manual click
  // also gives a fresh dwell before the next automatic switch. Pauses when
  // the tab is hidden and honors prefers-reduced-motion.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setMode((m) => {
        const i = MODES.findIndex((x) => x.id === m);
        return MODES[(i + 1) % MODES.length].id;
      });
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [mode]);

  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <div className={`${styles.landing} sp-landing-root`}>
        <Hero mode={mode} setMode={setMode} />
        <main>
          <EnvironmentPicker />
          <Capabilities />
        </main>
        <CtaSection />
      </div>
    </Layout>
  );
}
