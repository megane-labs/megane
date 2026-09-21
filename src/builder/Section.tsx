/**
 * A collapsible sidebar section. Its open / closed state is remembered per
 * section id in `localStorage`, so the sidebar comes back the way it was
 * left; a blocked storage leaves it in memory only.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { sectionStyle, sectionTitleStyle, hintStyle } from "./styles";

export const SECTIONS_STORAGE_KEY = "megane.builder.sections.v1";

type OpenMap = Record<string, boolean>;

function readOpen(storage: Storage | null): OpenMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OpenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOpen(storage: Storage | null, id: string, open: boolean) {
  if (!storage) return;
  try {
    storage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify({ ...readOpen(storage), [id]: open }));
  } catch {
    /* quota or blocked storage: the state stays in memory */
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether section `id` is open: the stored choice, else `defaultOpen`. */
export function useSectionOpen(
  id: string,
  defaultOpen: boolean,
  storage: Storage | null = defaultStorage(),
): [boolean, () => void] {
  const [open, setOpen] = useState(() => readOpen(storage)[id] ?? defaultOpen);
  useEffect(() => {
    setOpen(readOpen(storage)[id] ?? defaultOpen);
  }, [id, defaultOpen, storage]);
  const toggle = useCallback(() => {
    setOpen((o) => {
      writeOpen(storage, id, !o);
      return !o;
    });
  }, [id, storage]);
  return [open, toggle];
}

export interface SectionProps {
  /** Stable id, also the storage key and the `builder-section-<id>` test id. */
  id: string;
  title: string;
  /** Short text shown beside the title (a count, the cell size). */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Section({ id, title, summary, defaultOpen = true, children }: SectionProps) {
  const [open, toggle] = useSectionOpen(id, defaultOpen);
  return (
    <div style={{ ...sectionStyle, gap: open ? 8 : 0 }} data-testid={`builder-section-${id}`}>
      <div
        role="button"
        aria-expanded={open}
        data-testid={`builder-section-${id}-toggle`}
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 10,
            fontSize: 10,
            color: "var(--megane-text-secondary, #64748b)",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms",
          }}
        >
          ▶
        </span>
        <span style={sectionTitleStyle}>{title}</span>
        <span style={{ flex: 1 }} />
        {summary !== undefined && summary !== null && (
          <span style={hintStyle} data-testid={`builder-section-${id}-summary`}>
            {summary}
          </span>
        )}
      </div>
      {open && children}
    </div>
  );
}
