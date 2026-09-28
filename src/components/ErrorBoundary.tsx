/**
 * Top-level error boundary for the megane viewer.
 *
 * Without this, any error thrown while rendering the viewer or inside one of
 * its effects (most commonly `new THREE.WebGLRenderer()` failing when the host
 * cannot create a WebGL2 context) propagates to the React root, which then
 * unmounts the entire tree. The user is left staring at a blank white panel
 * with no hint about what went wrong — exactly the "VSCode webview is blank"
 * symptom. Catching the error here keeps a readable, actionable message on
 * screen instead, and re-logs it so it is visible in the webview devtools.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  // Optional so the boundary can be created via React.createElement with the
  // children passed as the variadic third argument (see src/widget.ts).
  children?: ReactNode;
  /** Optional extra context shown above the error (e.g. the host name). */
  context?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Heuristic: does this look like a failure to obtain a WebGL2 context? */
function isWebGLError(error: Error): boolean {
  const msg = `${error.name} ${error.message}`.toLowerCase();
  return (
    msg.includes("webgl") ||
    msg.includes("webgl2") ||
    msg.includes("context") ||
    msg.includes("gpu")
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Re-log so the underlying error (and component stack) is discoverable in
    // the host's developer tools even though we swallow it for the UI.
    console.error("megane: viewer crashed", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const webgl = isWebGLError(error);
    const title = webgl ? "WebGL is unavailable" : "Something went wrong";
    const hint = webgl
      ? "megane renders molecules with WebGL2, which this environment could not initialize. " +
        "This usually means hardware acceleration is disabled. In VS Code, set " +
        '"disable-hardware-acceleration" to false (or remove it) and restart, and make sure ' +
        "your GPU drivers are up to date."
      : "The molecular viewer failed to start. See the developer tools console for details.";

    return (
      <div
        data-testid="megane-error-boundary"
        data-webgl={webgl ? "true" : "false"}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          padding: "24px",
          gap: "10px",
          textAlign: "center",
          background: "var(--megane-bg)",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "15px", color: "var(--megane-danger)" }}>
          {title}
        </div>
        <div
          style={{
            color: "var(--megane-text-secondary)",
            fontSize: "13px",
            maxWidth: "440px",
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
        <div
          style={{
            color: "var(--megane-text-secondary)",
            fontSize: "12px",
            maxWidth: "440px",
            wordBreak: "break-word",
            opacity: 0.8,
            fontFamily: "monospace",
          }}
        >
          {error.message || String(error)}
        </div>
      </div>
    );
  }
}
