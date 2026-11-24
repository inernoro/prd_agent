/** Matches console-api MembershipPolicy: accept a short name or its existing tenant prefix. */
export function canonicalMemberUsername(tenantSlug: string | undefined, requested: string): string | null {
  const slug = tenantSlug?.trim().toLowerCase();
  if (!slug) return null;
  const prefix = `${slug}.`;
  let shortName = requested.trim().toLowerCase();
  if (shortName.startsWith(prefix)) shortName = shortName.slice(prefix.length);
  const canonical = prefix + shortName;
  return /^[a-z0-9][a-z0-9._-]{2,47}$/.test(shortName) && canonical.length <= 128 ? canonical : null;
}
