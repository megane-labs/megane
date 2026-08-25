import React from "react";
import Link from "@docusaurus/Link";
import styles from "./CtaBridge.module.css";

/**
 * CtaBridge — a full-width dark band that bridges docs → marketing, matching
 * the landing hero's spectral-dark tone. Registered globally via
 * src/theme/MDXComponents.tsx, so any doc page can drop in:
 *
 *   <CtaBridge />
 *
 * without importing it. Colors are literal (not --ifm-* tokens) so the band
 * stays dark in both docs color modes.
 */
const DEMO_URL = "https://megane-labs.github.io/megane/app/";
const GITHUB_URL = "https://github.com/megane-labs/megane";

export default function CtaBridge({
  title = "Ready to see it move?",
  subtitle = "Open the live demo — a million atoms, right in your browser.",
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <aside className={styles.bridge}>
      <div className={styles.text}>
        <div className={styles.title}>{title}</div>
        <div className={styles.subtitle}>{subtitle}</div>
      </div>
      <div className={styles.actions}>
        <Link className={styles.primary} href={DEMO_URL}>
          Launch demo →
        </Link>
        <Link className={styles.secondary} href={GITHUB_URL}>
          GitHub
        </Link>
      </div>
    </aside>
  );
}
