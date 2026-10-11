// Display-only classification. Never use a response shape to grant permissions.
export function isSupportedWidgetEncoding(value: string): boolean {
  return ['', 'identity', 'gzip', 'br', 'deflate'].includes(value.trim().toLowerCase());
}

export function hasWidgetMarkupPrefix(body: Buffer): boolean {
  // A mislabeled JSON RPC response is not a page, even when its fields contain
  // HTML tags. Unknown/whitespace-only prefixes conservatively skip injection.
  return body.subarray(0, 4 * 1024).toString('utf8').trimStart().startsWith('<');
}

// Representation headers on bodyless responses are metadata, not bytes to decode.
export function hasWidgetResponseBody(method: string | undefined, status: number): boolean {
  return method?.toUpperCase() !== 'HEAD' && status >= 200 && status < 300 && status !== 204 && status !== 205;
}
