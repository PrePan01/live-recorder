/** Alt is labelled Option on Mac keyboards; the KeyboardEvent binding is the same. */
export function formatAltShortcut(key: string): string {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac/i.test(navigator.platform || navigator.userAgent);
  return `${isMac ? "Option" : "Alt"}+${key}`;
}
