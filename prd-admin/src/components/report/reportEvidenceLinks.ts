/** Opaque IDs stay text; explicit web URLs and safe same-origin paths can be opened. */
export function reportSourceHref(reference: string): string | undefined {
  if (reference.startsWith('/') && !reference.startsWith('//') && !/[\\\r\n]/.test(reference)) return reference;
  try {
    const parsed = new URL(reference);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? reference : undefined;
  } catch {
    return undefined;
  }
}
