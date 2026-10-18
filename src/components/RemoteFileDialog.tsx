/**
 * megane's own file dialog over a `browse` remote file source: the server's
 * folders and the files a Load node accepts, for hosts that expose a
 * directory tree but no dialog of their own (`megane serve`, JupyterLab).
 *
 * Mounted via portal so it escapes the React Flow transform. Each source
 * remembers the last folder the dialog showed, so the next pick starts there.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/useDismiss";
import type { BrowsableRemoteFileSource, RemoteDirListing } from "../remote/fileSource";

interface RemoteFileDialogProps {
  source: BrowsableRemoteFileSource;
  title: string;
  /** Whether a file of this name can be opened (others are listed, disabled). */
  accept: (name: string) => boolean;
  onPick: (file: File) => void;
  onClose: () => void;
}

const lastPath = new WeakMap<BrowsableRemoteFileSource, string>();

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
  borderRadius: 16,
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
  border: "1px solid var(--megane-border)",
  maxWidth: 560,
  width: "90vw",
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  color: "var(--megane-text)",
  fontSize: 13,
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const titleStyle: React.CSSProperties = { fontSize: 16, fontWeight: 700 };

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 18,
  color: "var(--megane-text-muted)",
  padding: 4,
};

const pathRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const pathStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--megane-text-secondary)",
};

const listStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  background: "var(--megane-surface-raised)",
  height: 320,
  overflowY: "auto",
  margin: 0,
  padding: 4,
  listStyle: "none",
};

const smallBtnStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-strong)",
  background: "var(--megane-surface-raised)",
  color: "var(--megane-text)",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const openBtnStyle: React.CSSProperties = {
  ...smallBtnStyle,
  border: "1px solid rgba(16, 185, 129, 0.35)",
  background: "rgba(16, 185, 129, 0.1)",
  color: "var(--megane-success-text)",
  fontWeight: 600,
  padding: "7px 14px",
  fontSize: 13,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const messageStyle: React.CSSProperties = {
  padding: 12,
  color: "var(--megane-text-muted)",
};

const errorStyle: React.CSSProperties = {
  color: "var(--megane-danger-text)",
};

function entryStyle(selected: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    border: "none",
    borderRadius: 6,
    padding: "5px 8px",
    background: selected ? "rgba(59, 130, 246, 0.15)" : "transparent",
    color: disabled ? "var(--megane-text-muted)" : "var(--megane-text)",
    opacity: disabled ? 0.55 : 1,
    cursor: disabled ? "default" : "pointer",
    fontSize: 13,
    fontFamily: "inherit",
    textAlign: "left",
  };
}

function stop(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

function formatSize(size: number | null | undefined): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function RemoteFileDialog({
  source,
  title,
  accept,
  onPick,
  onClose,
}: RemoteFileDialogProps) {
  const titleId = useId();
  const [listing, setListing] = useState<RemoteDirListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDismiss({ onDismiss: onClose });

  const navigate = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = await source.list(path);
        setListing(next);
        setSelected(null);
        lastPath.set(source, next.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [source],
  );

  useEffect(() => {
    void navigate(lastPath.get(source) ?? source.initialPath?.() ?? "");
  }, [navigate, source]);

  const open = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const file = await source.read(path);
        onPick(file);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [source, onPick, onClose],
  );

  return createPortal(
    // React events bubble through a portal to the Load node that opened the
    // dialog, so they stop here and never reach the node's own handlers.
    <div
      style={backdropStyle}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      data-testid="remote-file-dialog-backdrop"
    >
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="remote-file-dialog"
      >
        <div style={headerRowStyle}>
          <span id={titleId} style={titleStyle}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={closeBtnStyle}
            aria-label="Close"
            data-testid="remote-file-dialog-close"
          >
            ✕
          </button>
        </div>

        <div style={pathRowStyle}>
          <button
            type="button"
            style={smallBtnStyle}
            disabled={busy || listing?.parent == null}
            onClick={() => listing?.parent != null && void navigate(listing.parent)}
            data-testid="remote-file-dialog-up"
            aria-label="Parent folder"
          >
            ↑ Up
          </button>
          <span style={pathStyle} data-testid="remote-file-dialog-path" title={listing?.path}>
            /{listing?.path ?? ""}
          </span>
        </div>

        <ul style={listStyle} data-testid="remote-file-dialog-list" aria-busy={busy}>
          {listing?.entries.length === 0 && <li style={messageStyle}>This folder is empty.</li>}
          {listing?.entries.map((entry) => {
            const disabled = !entry.isDir && !accept(entry.name);
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  style={entryStyle(selected === entry.path, disabled)}
                  disabled={disabled || busy}
                  data-testid="remote-file-dialog-entry"
                  data-name={entry.name}
                  data-kind={entry.isDir ? "dir" : "file"}
                  onClick={() =>
                    entry.isDir ? void navigate(entry.path) : setSelected(entry.path)
                  }
                  onDoubleClick={() => !entry.isDir && void open(entry.path)}
                >
                  <span aria-hidden="true">{entry.isDir ? "📁" : "📄"}</span>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                    {entry.name}
                  </span>
                  {!entry.isDir && (
                    <span style={{ color: "var(--megane-text-muted)", fontSize: 11 }}>
                      {formatSize(entry.size)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {error && (
          <div style={errorStyle} role="alert" data-testid="remote-file-dialog-error">
            {error}
          </div>
        )}

        <div style={footerStyle}>
          <button type="button" style={smallBtnStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={openBtnStyle}
            disabled={busy || selected === null}
            onClick={() => selected !== null && void open(selected)}
            data-testid="remote-file-dialog-open"
          >
            Open
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
