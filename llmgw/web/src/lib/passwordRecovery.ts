/** These codes are emitted before a password write (or an atomic write was rejected). */
const PASSWORD_REJECTIONS = new Set(['INVALID_INPUT', 'WEAK_PASSWORD', 'SAME_PASSWORD', 'INVALID_USERNAME', 'USERNAME_TAKEN', 'INVALID_CREDENTIALS', 'UNAUTHORIZED', 'SESSION_EXPIRED', 'PASSWORD_MANAGED_BY_DEPLOYMENT', 'PASSWORD_CHANGE_CONFLICT']);
export function isPasswordChangeUncertain(code?: string) { return !code || !PASSWORD_REJECTIONS.has(code); }
