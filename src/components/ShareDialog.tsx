/**
 * Share dialog – shows the encoded pipeline URL and offers copy / open-in-tab.
 *
 * Mounted via portal so it escapes the React Flow z-index / overflow stack.
 * Copy uses the modern Clipboard API with an `execCommand('copy')` fallback;
 * even if every clipboard path fails the URL is selectable from the dialog
 * input and from the address bar.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyShareUrl as defaultCopy } from "../pipeline/shareLink";

type CopyState = "idle" | "copying" | "copied" | "failed";

interface ShareDialogProps {
  open: boolean;
  url: string;
  tooLong: boolean;
  onClose: () => void;
  /** DI hook for tests; defaults to the real `copyShareUrl`. */
  copy?: (url: string) => Promise<"copied" | "failed">;
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.3)",
  backdropFilter: "blur(4px)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panelStyle: React.CSSProperties = {
  background: "var(--megane-surface)",
  backdropFilter: "blur(16px)",
  borderRadius: 16,
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
  border: "1px solid var(--megane-border)",
  maxWidth: 520,
  width: "90vw",
  padding: "20px 24px",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 16,
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: "var(--megane-text)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 18,
  color: "var(--megane-text-muted)",
  padding: 4,
};

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "var(--megane-surface-raised)",
  color: "var(--megane-text)",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginTop: 14,
};

const copyBtnBaseStyle: React.CSSProperties = {
  border: "1px solid rgba(16, 185, 129, 0.35)",
  background: "rgba(16, 185, 129, 0.1)",
  color: "var(--megane-success-text)",
  padding: "7px 14px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const copyBtnDisabledStyle: React.CSSProperties = {
  ...copyBtnBaseStyle,
  background: "rgba(148, 163, 184, 0.08)",
  border: "1px solid rgba(148, 163, 184, 0.3)",
  color: "var(--megane-text-muted)",
  cursor: "not-allowed",
};

const copyBtnFailedStyle: React.CSSProperties = {
  ...copyBtnBaseStyle,
  background: "rgba(220, 38, 38, 0.1)",
  border: "1px solid rgba(220, 38, 38, 0.35)",
  color: "var(--megane-danger-text)",
};

const openTabStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--megane-primary)",
  textDecoration: "none",
};

const warningStyle: React.CSSProperties = {
  background: "rgba(220, 38, 38, 0.08)",
  border: "1px solid rgba(220, 38, 38, 0.3)",
  borderRadius: 8,
  padding: "10px 12px",
  color: "var(--megane-danger-text)",
  fontSize: 13,
  marginBottom: 12,
  lineHeight: 1.4,
};

function copyBtnLabel(state: CopyState): string {
  if (state === "copying") return "Copying…";
  if (state === "copied") return "Copied!";
  if (state === "failed") return "Copy failed";
  return "Copy link";
}

function copyBtnStyleFor(state: CopyState, disabled: boolean): React.CSSProperties {
  if (disabled) return copyBtnDisabledStyle;
  if (state === "failed") return copyBtnFailedStyle;
  return copyBtnBaseStyle;
}

export function ShareDialog({ open, url, tooLong, onClose, copy }: ShareDialogProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    setCopyState("idle");
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, url]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase + preventDefault so this Escape is unambiguously ours:
        // stopPropagation does not stop other listeners on the same target, and
        // MeganeViewer's selection-clearing listener registers first (at mount),
        // so ordering alone can't be relied on.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      if (revertTimerRef.current !== null) {
        clearTimeout(revertTimerRef.current);
        revertTimerRef.current = null;
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (tooLong) return;
    if (revertTimerRef.current !== null) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = null;
    }
    setCopyState("copying");
    const fn = copy ?? defaultCopy;
    const result = await fn(url);
    setCopyState(result);
    revertTimerRef.current = setTimeout(() => {
      setCopyState("idle");
      revertTimerRef.current = null;
    }, 2500);
  }, [copy, tooLong, url]);

  if (!open) return null;

  const copyDisabled = tooLong || copyState === "copying";

  return createPortal(
    <div style={backdropStyle} onClick={onClose} data-testid="share-dialog-backdrop">
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="share-dialog"
      >
        <div style={headerRowStyle}>
          <span id={titleId} style={titleStyle}>
            Share pipeline
          </span>
          <button
            type="button"
            onClick={onClose}
            style={closeBtnStyle}
            aria-label="Close"
            data-testid="share-dialog-close"
          >
            ✕
          </button>
        </div>

        {tooLong && (
          <div style={warningStyle} data-testid="share-dialog-warning">
            Pipeline too large to share via URL (over 8000 characters). Use Export instead.
          </div>
        )}

        <input
          ref={inputRef}
          type="text"
          readOnly
          value={url}
          style={inputStyle}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.currentTarget.select()}
          data-testid="share-dialog-url-input"
          aria-label="Share URL"
        />

        <div style={buttonRowStyle}>
          <button
            type="button"
            onClick={handleCopy}
            disabled={copyDisabled}
            style={copyBtnStyleFor(copyState, copyDisabled)}
            data-testid="share-dialog-copy"
            data-state={copyState}
          >
            {copyBtnLabel(copyState)}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={openTabStyle}
            data-testid="share-dialog-open-tab"
          >
            Open in new tab
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
