import { createHash } from 'node:crypto';
import type { CdsSession } from '../domain/auth.js';
import { ACCOUNT_SIGNOUT_PROOF_COOKIE, sessionCookieName } from './browser-session-cookies.js';

export const accountNoticeRetentionMs = 30 * 24 * 60 * 60_000;

function noticeDigest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function proofFor(token: string) {
  return noticeDigest('cds-signout-proof:' + token);
}

export function accountSignoutDigest(token: string) {
  return noticeDigest(proofFor(token));
}

export function readAccountSignoutProof(value?: string) {
  const parts = value?.match(/^([A-Za-z0-9_-]{1,320})[.]([a-f0-9]{64})$/);
  return parts ? { accountId: Buffer.from(parts[1], 'base64url').toString('utf8'), digest: noticeDigest(parts[2]) } : undefined;
}

export function buildAccountSignoutCookie(session: Pick<CdsSession, 'userId' | 'token' | 'expiresAt'>, secure: boolean, host: boolean) {
  // The independent proof grants access only to the receipt for a revoked browser.
  const maxAge = Math.max(0, Math.ceil((Date.parse(session.expiresAt) + accountNoticeRetentionMs - Date.now()) / 1000));
  const accountId = Buffer.from(session.userId, 'utf8').toString('base64url');
  return [sessionCookieName(ACCOUNT_SIGNOUT_PROOF_COOKIE, host) + '=' + accountId + '.' + proofFor(session.token),
    'Path=/', 'SameSite=Lax', 'HttpOnly', 'Max-Age=' + maxAge, ...((secure || host) ? ['Secure'] : [])].join('; ');
}
