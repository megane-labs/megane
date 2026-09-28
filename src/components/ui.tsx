/**
 * Shared UI components and styles for sidebar panels.
 */

import { useCallback, useRef } from "react";

export const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--megane-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 6,
};

export const smallBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  padding: "3px 17px",
  cursor: "pointer",
  fontSize: 19,
  fontWeight: 500,
  color: "var(--megane-text-secondary)",
  transition: "all 0.15s",
};

export const activeBtnStyle: React.CSSProperties = {
  ...smallBtnStyle,
  background: "rgba(59, 130, 246, 0.08)",
  borderColor: "rgba(59, 130, 246, 0.25)",
  color: "var(--megane-primary)",
};

export const fileNameStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: "var(--megane-text)",
  wordBreak: "break-all",
};

export const statsStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--megane-text-muted)",
  marginTop: 2,
};

export const placeholderStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--megane-text-muted)",
  fontStyle: "italic",
};

export function matchesAccept(name: string, exts: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

export function DropZone({
  accept,
  exts,
  onFile,
  label,
  children,
  testId,
}: {
  accept: string;
  exts: readonly string[];
  onFile: (file: File) => void;
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) => matchesAccept(f.name, exts));
      if (match) onFile(match);
    },
    [exts, onFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const match = Array.from(files).find((f) => matchesAccept(f.name, exts));
      if (match) onFile(match);
      e.target.value = "";
    },
    [exts, onFile],
  );

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{ minHeight: 0 }}
      data-testid={testId ? `${testId}-dropzone` : undefined}
    >
      {children}
      <button
        onClick={() => inputRef.current?.click()}
        style={{ ...smallBtnStyle, marginTop: 10 }}
        data-testid={testId ? `${testId}-button` : undefined}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        style={{ display: "none" }}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </div>
  );
}

/** Tab-style selector for 2-4 options. */
export function TabSelector<T extends string>({
  options,
  value,
  onChange,
  disabledOptions,
  ariaLabel,
  tabIdFor,
  panelIdFor,
  testIdFor,
  size = "default",
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabledOptions?: Set<T>;
  /** Accessible label for the tablist as a whole. */
  ariaLabel?: string;
  /** Optional id generator so panels can reference the tab via aria-labelledby. */
  tabIdFor?: (v: T) => string;
  /** Optional id generator for the controlled tabpanel (used in aria-controls). */
  panelIdFor?: (v: T) => string;
  /** Optional data-testid generator for each tab button. */
  testIdFor?: (v: T) => string;
  /** "compact" trims font size + padding for in-header use. */
  size?: "default" | "compact";
}) {
  const compact = size === "compact";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: "flex",
        borderRadius: compact ? 6 : 10,
        overflow: "hidden",
        border: "1px solid var(--megane-border-solid)",
        marginBottom: compact ? 0 : 10,
      }}
    >
      {options.map((opt, idx) => {
        const isActive = opt.value === value;
        const isDisabled = disabledOptions?.has(opt.value) ?? false;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            id={tabIdFor?.(opt.value)}
            aria-selected={isActive}
            aria-controls={panelIdFor?.(opt.value)}
            data-testid={testIdFor?.(opt.value)}
            tabIndex={isActive ? 0 : -1}
            onClick={isActive || isDisabled ? undefined : () => onChange(opt.value)}
            style={{
              flex: 1,
              background: isActive ? "rgba(59,130,246,0.08)" : "none",
              border: "none",
              borderRight:
                idx < options.length - 1 ? "1px solid var(--megane-border-solid)" : "none",
              padding: compact ? "4px 0" : "7px 0",
              cursor: isActive || isDisabled ? "default" : "pointer",
              fontSize: compact ? 12 : 19,
              fontWeight: compact ? 600 : 500,
              color: isDisabled
                ? "var(--megane-text-muted)"
                : isActive
                  ? "var(--megane-primary)"
                  : "var(--megane-text-muted)",
              transition: "all 0.15s",
            }}
            disabled={isDisabled}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
