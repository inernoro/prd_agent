/**
 * Trusted request stamps installed by the top-level authentication middleware.
 * Route handlers must not infer system-owner access from the mere presence of a
 * user object: every persisted account has cdsUser + cdsSession.
 */
export interface HumanAuthContext {
  _cdsBasicHumanAuth?: boolean;
  cdsUser?: {
    isSystemOwner?: boolean;
    authProvider?: string;
  };
  cdsSession?: unknown;
}

/** True only for an authenticated, non-SSO human who is a CDS system owner. */
export function isHumanSystemOwner(request: unknown): boolean {
  const auth = request as HumanAuthContext;
  const hasVerifiedHumanSession = auth._cdsBasicHumanAuth === true
    || Boolean(auth.cdsSession && auth.cdsUser);
  return Boolean(
    hasVerifiedHumanSession
    && auth.cdsUser?.isSystemOwner === true
    && auth.cdsUser.authProvider !== 'sso',
  );
}
