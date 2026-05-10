export const LAST_VERSION_KEY = 'prd-desktop-last-launched-version';
export const POST_UPDATE_PENDING_VERSION_KEY = 'prd-desktop-post-update-summary-pending-version';
export const SEEN_PREFIX = 'prd-desktop-post-update-summary-seen:';

export function normalizeDesktopVersion(version: string | null | undefined) {
  return String(version || '').trim().replace(/^v/i, '');
}

export function postUpdateSeenKey(version: string) {
  return `${SEEN_PREFIX}${version}`;
}

export interface PostUpdateSummaryDecisionInput {
  currentVersion: string | null | undefined;
  lastVersion: string | null | undefined;
  pendingVersion: string | null | undefined;
  alreadySeen: boolean;
  hasExistingDesktopState: boolean;
}

export function shouldShowPostUpdateSummary(input: PostUpdateSummaryDecisionInput) {
  const version = normalizeDesktopVersion(input.currentVersion);
  if (!version || input.alreadySeen) return false;

  const lastVersion = normalizeDesktopVersion(input.lastVersion);
  const pendingVersion = normalizeDesktopVersion(input.pendingVersion);

  return (
    pendingVersion === version ||
    Boolean(lastVersion && lastVersion !== version) ||
    (!lastVersion && input.hasExistingDesktopState)
  );
}
