// Display-only classification. Never use a response shape to grant permissions.
export function isSupportedWidgetEncoding(value: string): boolean {
  return ['', 'identity', 'gzip', 'br', 'deflate'].includes(value.trim().toLowerCase());
}

export function hasWidgetMarkupPrefix(body: Buffer): boolean {
  // A mislabeled JSON RPC response is not a page, even when its fields contain
  // HTML tags. Unknown/whitespace-only prefixes conservatively skip injection.
  return body.subarray(0, 4 * 1024).toString('utf8').trimStart().startsWith('<');
}
