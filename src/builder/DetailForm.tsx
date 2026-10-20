/**
 * The card a form opens in the Details panel (New structure, a Structure ›
 * form, the tool server, a Python tool): a titled, bordered card, a Close
 * button when the form has one, and Escape to close it — through the shared
 * dismiss stack, so an atom menu or a rail menu opened over the form takes
 * Escape first. When it opens, focus moves to its first field, so a form
 * opened from the keyboard can be filled straight away; later re-renders
 * leave focus where it is (the 3D view keeps it).
 */

import { useEffect, useRef, type ReactNode } from "react";
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

/** What a form's opening focus may land on, in the order tried. */
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';
const CONTROL_SELECTOR = 'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The control a form's opening focus goes to: its first field, else its
 * first other control that is not the Close button; null when it has none.
 */
export function firstFormControl(card: HTMLElement, closeTestId?: string): HTMLElement | null {
  const field = card.querySelector<HTMLElement>(FIELD_SELECTOR);
  if (field) return field;
  for (const el of card.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
    if (!closeTestId || el.dataset.testid !== closeTestId) return el;
  }
  return null;
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

  // Only on opening: a re-render must not pull focus away from the view.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || card.contains(document.activeElement)) return;
    firstFormControl(card, closeTestId)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={cardRef}
      data-testid={testId}
      {...data}
      role="dialog"
      aria-label={title}
      style={detailCardStyle}
    >
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
