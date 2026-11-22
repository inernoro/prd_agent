import { createHmac, randomBytes } from 'node:crypto';
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { CdsPasskeyStore } from '../domain/passkey.js';
import type { AuthService } from './auth-service.js';
import { ExpiringTokens } from './expiring-tokens.js';

const APPROVAL_TTL_MS = 2 * 60_000;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,2048}$/;

export function createSystemPasswordApproval(origin: URL, auth: AuthService, store: CdsPasskeyStore, configuredIds: string | undefined) {
  const ids = new Set((configuredIds ?? '').split(',').map(id => id.trim()).filter(Boolean));
  if (!ids.size || [...ids].some(id => !CREDENTIAL_ID.test(id))) return null;

  const bindingKey = randomBytes(32);
  const bind = (password: string) => createHmac('sha256', bindingKey).update(password).digest('base64url');
  const pending = new ExpiringTokens<{ challenge: string; password: string }>(256);

  return {
    async issue(newPassword: string) {
      const options = await generateAuthenticationOptions({
        rpID: origin.hostname,
        userVerification: 'required',
        timeout: APPROVAL_TTL_MS,
        allowCredentials: [...ids].map(id => ({ id })),
      });
      const ticket = pending.issue({ challenge: options.challenge, password: bind(newPassword) }, APPROVAL_TTL_MS);
      return ticket ? { ticket, options, expiresInSeconds: APPROVAL_TTL_MS / 1000 } : null;
    },

    async verify(ticket: string | null, newPassword: string, assertion: AuthenticationResponseJSON | undefined) {
      const approval = pending.read(ticket, true);
      if (!approval || approval.password !== bind(newPassword) || typeof assertion?.id !== 'string' || !ids.has(assertion.id)) return null;
      const key = await store.find(assertion.id);
      if (!key) return null;
      const result = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: approval.challenge,
        expectedOrigin: origin.origin,
        expectedRPID: origin.hostname,
        requireUserVerification: true,
        credential: { id: key.id, publicKey: Uint8Array.from(Buffer.from(key.publicKey, 'base64url')), counter: key.counter },
      }).catch(() => null);
      if (!result?.verified || !await store.advanceCounter(key.id, key.counter, result.authenticationInfo.newCounter)) return null;
      const approver = await auth.findUserById(key.userId);
      return approver?.isSystemOwner && approver.status === 'active' && (approver.username || approver.githubLogin)
        ? approver
        : null;
    },
  };
}
