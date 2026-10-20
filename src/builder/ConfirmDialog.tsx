/**
 * The Builder's confirm dialog: the one place it asks before doing something
 * that cannot be undone (see `ConfirmRequest` in `store.ts`). Drawn over the
 * Builder itself rather than the page, so an embedded Builder (a VS Code tab,
 * a notebook cell) asks inside its own frame; `window.confirm` is not used
 * because VS Code webviews never show it.
 *
 * The go-ahead button takes the focus, so Enter answers yes; Escape and
 * Cancel answer no. `aria-modal` pauses the Builder's keyboard shortcuts
 * while it is open (`shortcuts.ts`).
 */

import { useEffect, useRef } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { floatingSurfaceStyle } from "../components/toolbarStyles";
import { useScopedBuilderStore } from "./BuilderStores";
import { buttonStyle, hintStyle } from "./styles";

export function ConfirmHost() {
  const confirm = useScopedBuilderStore((s) => s.confirm);
  const resolveConfirm = useScopedBuilderStore((s) => s.resolveConfirm);
  const goRef = useRef<HTMLButtonElement>(null);

  useDismiss({ onDismiss: () => resolveConfirm(false), enabled: confirm !== null });
  useEffect(() => {
    if (confirm) goRef.current?.focus();
  }, [confirm]);

  if (!confirm) return null;
  return (
    <div
      data-testid="builder-confirm-backdrop"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        data-testid="builder-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="builder-confirm-title"
        aria-describedby="builder-confirm-message"
        style={{
          ...floatingSurfaceStyle,
          background: "var(--megane-surface-solid, #fff)",
          maxWidth: 420,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontSize: 13,
          color: "var(--megane-text, #1e293b)",
        }}
      >
        <div id="builder-confirm-title" style={{ fontWeight: 700, fontSize: 14 }}>
          {confirm.title}
        </div>
        <div id="builder-confirm-message" style={{ ...hintStyle, fontSize: 13 }}>
          {confirm.message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            data-testid="builder-confirm-cancel"
            style={buttonStyle()}
            onClick={() => resolveConfirm(false)}
          >
            Cancel
          </button>
          <button
            ref={goRef}
            type="button"
            data-testid="builder-confirm-ok"
            style={buttonStyle(confirm.danger ? "danger" : "primary")}
            onClick={() => resolveConfirm(true)}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
