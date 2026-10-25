/**
 * Per-atom residue labels ("HOH42", "ALA7", …) as they cross from the parser
 * to the viewer.
 *
 * The parsers hand labels over as one newline-joined string. Splitting it
 * naively makes one JS string per atom, and posting a `string[]` from the
 * parse worker clones every element again on the main thread (structured
 * clone does not share repeated strings). Atoms of one residue sit next to
 * each other and share their label, so {@link splitLabels} reuses the
 * previous string for a repeat, and the worker posts the joined text
 * ({@link packLabels}) for the main thread to split ({@link unpackLabels}).
 */

/** Split newline-joined labels like `text.split("\n")`, sharing each run of
 *  equal neighbours as one string. */
export function splitLabels(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let prev = "";
  let start = 0;
  for (;;) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = n;
    if (end - start === prev.length && text.startsWith(prev, start)) {
      out.push(prev);
    } else {
      prev = text.slice(start, end);
      out.push(prev);
    }
    if (end === n) return out;
    start = end + 1;
  }
}

/** The joined text each parse result's labels were split from. */
const sourceText = new WeakMap<string[], string>();

/** Split `text` into labels, remembering the text so it can be posted as-is. */
export function labelsFromText(text: string): string[] {
  const labels = splitLabels(text);
  sourceText.set(labels, text);
  return labels;
}

/** What a result's labels look like on the wire. */
export interface PackedLabels {
  labels: string[] | null;
  /** Newline-joined labels, in place of `labels`, between worker and page. */
  labelsText?: string;
}

/** Replace `labels` by its joined text for posting out of the worker. */
export function packLabels<T extends PackedLabels>(result: T): T {
  if (!result.labels) return result;
  const labelsText = sourceText.get(result.labels) ?? result.labels.join("\n");
  return { ...result, labels: null, labelsText };
}

/** Undo {@link packLabels} on a result posted by the worker (in place). */
export function unpackLabels<T extends PackedLabels>(result: T): T {
  if (typeof result.labelsText === "string") {
    result.labels = splitLabels(result.labelsText);
    delete result.labelsText;
  }
  return result;
}
