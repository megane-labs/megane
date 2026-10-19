/**
 * The Load nodes' "Open from server..." button: picks a file through the
 * page's remote file source (`src/remote/fileSource.ts`) — the host's own
 * dialog for a `native` source, `RemoteFileDialog` for a `browse` one — and
 * hands it to the same handler a dropped or uploaded file goes to.
 */

import { useCallback, useState, type ReactNode } from "react";
import { RemoteFileDialog } from "../RemoteFileDialog";
import { useRemoteFileSource, type RemoteFileKind } from "../../remote/fileSource";

interface RemoteFilePickOptions {
  kind: RemoteFileKind;
  /** The dialog's filter, with dots (`.pdb`). */
  extensions: readonly string[];
  /** Whether the node can load a file of this name. */
  accept: (name: string) => boolean;
  /** The dialog's title, e.g. "Open structure". */
  title: string;
  onFile: (file: File) => void;
}

export interface RemoteFilePick {
  /** The button for `FileDrop`'s `remote` prop; null when the host has no source. */
  button: { label: string; onPick: () => void } | null;
  /** The open dialog, to render anywhere in the node (it portals itself). */
  dialog: ReactNode;
  /** Why the last pick failed, if it did. */
  error: string | null;
}

export function useRemoteFilePick({
  kind,
  extensions,
  accept,
  title,
  onFile,
}: RemoteFilePickOptions): RemoteFilePick {
  const source = useRemoteFileSource();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deliver = useCallback(
    (file: File) => {
      if (!accept(file.name)) {
        setError(`${file.name} is not a ${kind} file Megane can open.`);
        return;
      }
      setError(null);
      onFile(file);
    },
    [accept, kind, onFile],
  );

  const onPick = useCallback(() => {
    if (!source) return;
    if (source.mode === "browse") {
      setDialogOpen(true);
      return;
    }
    source.pick({ kind, extensions }).then(
      (file) => file && deliver(file),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [source, kind, extensions, deliver]);

  const closeDialog = useCallback(() => setDialogOpen(false), []);

  return {
    button: source ? { label: source.label, onPick } : null,
    dialog:
      dialogOpen && source?.mode === "browse" ? (
        <RemoteFileDialog
          source={source}
          title={title}
          accept={accept}
          onPick={deliver}
          onClose={closeDialog}
        />
      ) : null,
    error,
  };
}
