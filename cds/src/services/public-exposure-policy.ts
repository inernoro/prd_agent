/**
 * Public preview discovery is useful on trusted installations, but the
 * branch-gone page otherwise publishes running branch names and preview URLs
 * to anyone who guesses an unknown wildcard host. Preserve the historical
 * default and let internet-facing installations disable the list explicitly.
 */
export function isPublicPreviewDiscoveryEnabled(
  raw = process.env.CDS_PUBLIC_PREVIEW_DISCOVERY,
): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}
