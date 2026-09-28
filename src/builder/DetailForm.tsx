/**
 * The card a form opens in the Details panel (New structure, a Structure ›
 * form, the tool server, a Python tool): a titled, bordered card, a Close
 * button when the form has one, and Escape to close it — through the shared
 * dismiss stack, so an atom menu or a rail menu opened over the form takes
 * Escape first.
 */

import type { ReactNode } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { buttonStyle, detailCardStyle, hintStyle } from "./styles";

export interface DetailFormProps {
  title: string;
  /** A small line over the title saying where the form came from ("Structure ›"). */
  breadcrumb?: string;
  onClose: () => void;
  /** Test id of the Close button; without one the form has no Close button. */
  closeTestId?: string;
  /** Close (button and Escape) is refused while true, e.g. a tool running. */
  closeDisabled?: boolean;
  testId: string;
  /** Extra `data-*` attributes for the card. */
  data?: Record<`data-${string}`, string>;
  children: ReactNode;
}

export function DetailForm({
  title,
  breadcrumb,
  onClose,
  closeTestId,
  closeDisabled = false,
  testId,
  data,
  children,
}: DetailFormProps) {
  useDismiss({
    onDismiss: () => {
      if (!closeDisabled) onClose();
    },
  });

  return (
    <div data-testid={testId} {...data} role="dialog" aria-label={title} style={detailCardStyle}>
      {breadcrumb ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ ...hintStyle, fontSize: 11 }}>{breadcrumb}</span>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700 }}>{title}</span>
          <span style={{ flex: 1 }} />
          {closeTestId && (
            <button
              type="button"
              data-testid={closeTestId}
              style={buttonStyle("default", closeDisabled)}
              disabled={closeDisabled}
              onClick={onClose}
            >
              Close
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
