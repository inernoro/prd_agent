/**
 * Unit tests for the scrypt-based local password util (node:crypto only).
 * Covers: hash produces distinct salts, verify accepts the correct password,
 * verify rejects wrong passwords / tampered hashes, min-length enforcement,
 * and that malformed stored material returns false rather than throwing.
 */

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../../src/services/password.js';

describe('password util (scrypt)', () => {
  it('hashes and verifies the correct password', () => {
    const stored = hashPassword('correct horse battery');
    expect(stored.hash).toMatch(/^[0-9a-f]+$/);
    expect(stored.salt).toMatch(/^[0-9a-f]+$/);
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    const stored = hashPassword('right-password-1');
    expect(verifyPassword('wrong-password-1', stored)).toBe(false);
  });

  it('produces a unique salt per call (no hash reuse for same password)', () => {
    const a = hashPassword('same-password-xyz');
    const b = hashPassword('same-password-xyz');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // Both still verify their own input.
    expect(verifyPassword('same-password-xyz', a)).toBe(true);
    expect(verifyPassword('same-password-xyz', b)).toBe(true);
  });

  it('enforces the minimum password length on hash', () => {
    expect(() => hashPassword('short')).toThrow();
    // Exactly MIN length is allowed.
    const minPw = 'x'.repeat(MIN_PASSWORD_LENGTH);
    expect(verifyPassword(minPw, hashPassword(minPw))).toBe(true);
  });

  it('returns false (never throws) on malformed stored material', () => {
    expect(verifyPassword('anything', { hash: '', salt: '' })).toBe(false);
    expect(verifyPassword('anything', { hash: 'zz', salt: 'zz' })).toBe(false);
    // @ts-expect-error intentionally malformed
    expect(verifyPassword('anything', null)).toBe(false);
    expect(verifyPassword('', hashPassword('valid-password-1'))).toBe(false);
  });

  it('rejects when the stored hash is tampered (timing-safe path)', () => {
    const stored = hashPassword('tamper-target-1');
    const flipped = { ...stored, hash: stored.hash.slice(0, -1) + (stored.hash.endsWith('a') ? 'b' : 'a') };
    expect(verifyPassword('tamper-target-1', flipped)).toBe(false);
  });
});
