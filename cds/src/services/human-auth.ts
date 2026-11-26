/**
 * Trusted request stamps installed by the top-level authentication middleware.
 * Route handlers must not infer system-owner access from the mere presence of a
 * user object: every persisted account has cdsUser + cdsSession.
 */
export interface HumanAuthContext {
  _cdsBasicHumanAuth?: boolean;
  cdsUser?: {
    id?: string;
    isSystemOwner?: boolean;
    isAdministrator?: boolean;
    authProvider?: string;
    username?: string;
    githubLogin?: string;
    login?: string;
  };
  cdsSession?: unknown;
}

/** Canonical ID from verified session stamps, never from a display name or body. */
export function verifiedHumanAccountId(request: unknown): string | undefined {
  const auth = request as HumanAuthContext;
  return isAuthenticatedHuman(auth) && typeof auth.cdsUser?.id === 'string' && auth.cdsUser.id
    ? auth.cdsUser.id : undefined;
}

/** True only when middleware attached a verified human identity and session. */
export function isAuthenticatedHuman(request: unknown): boolean {
  const auth = request as HumanAuthContext;
  return Boolean(
    auth.cdsUser
    && (auth._cdsBasicHumanAuth === true || auth.cdsSession),
  );
}

/** True only for an authenticated, non-SSO human who is a CDS system owner. */
export function isHumanSystemOwner(request: unknown): boolean {
  const auth = request as HumanAuthContext;
  return Boolean(
    isAuthenticatedHuman(auth)
    && auth.cdsUser?.isSystemOwner === true
    && auth.cdsUser.authProvider !== 'sso',
  );
}
