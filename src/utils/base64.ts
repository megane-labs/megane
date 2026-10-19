/**
 * Decode a base64 string to bytes.
 *
 * The Jupyter Contents API hands binary files (ASE `.traj`, XTC companions, …)
 * over as base64, and these strings run to tens of MB for a trajectory. The
 * obvious `Uint8Array.from(atob(s), (c) => c.charCodeAt(0))` walks the string
 * through the iterator protocol with a callback per byte and costs ~2.5 s for a
 * 22 MB file; the native `Uint8Array.fromBase64` (where the engine has it) and
 * a plain indexed loop over `atob` both finish in ~0.1 s.
 *
 * Whitespace (line-wrapped base64) is accepted on both paths.
 */
export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> })
    .fromBase64;
  if (typeof native === "function") {
    try {
      return native.call(Uint8Array, b64);
    } catch {
      // Fall through: atob is more lenient about padding than fromBase64.
    }
  }
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
