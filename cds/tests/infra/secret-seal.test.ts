/**
 * FU-05 unit tests for the secret-seal helpers.
 *
 * The interesting invariants:
 *   1. Round-trip: seal → unseal returns the original plaintext
 *   2. Backwards compat: unseal on a legacy plaintext string still works
 *   3. Key opt-out: with no CDS_SECRET_KEY set, seal is a no-op
 *   4. Tamper detection: modifying ciphertext fails the GCM auth tag
 *   5. Key rotation: unseal with a different key fails cleanly
 *
 * We save/restore `process.env.CDS_SECRET_KEY` around each case so
 * other tests in the suite don't inherit a leftover key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sealToken,
  unsealToken,
  isSealedSecret,
  isSealingEnabled,
} from '../../src/infra/secret-seal.js';

describe('secret-seal (FU-05)', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.CDS_SECRET_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.CDS_SECRET_KEY;
    else process.env.CDS_SECRET_KEY = savedKey;
  });

  describe('no-key mode (legacy)', () => {
    beforeEach(() => {
      delete process.env.CDS_SECRET_KEY;
    });

    it('sealToken is a plaintext pass-through when no key is set', () => {
      const result = sealToken('gho_plaintext_token');
      expect(result).toBe('gho_plaintext_token');
    });

    it('unsealToken accepts a plain string and returns it unchanged', () => {
      expect(unsealToken('gho_plaintext_token')).toBe('gho_plaintext_token');
    });

    it('isSealingEnabled reports false', () => {
      expect(isSealingEnabled()).toBe(false);
    });

    it('unsealing a sealed secret without a key throws', () => {
      // First seal WITH a key, then drop the key, then try to unseal.
      process.env.CDS_SECRET_KEY = 'a'.repeat(64); // 64 hex chars
      const sealed = sealToken('gho_secret');
      expect(isSealedSecret(sealed)).toBe(true);
      delete process.env.CDS_SECRET_KEY;
      expect(() => unsealToken(sealed)).toThrow(/CDS_SECRET_KEY is not set/);
    });
  });

  describe('with 64-hex-char key', () => {
    beforeEach(() => {
      process.env.CDS_SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    });

    it('seals plaintext into a SealedSecret object', () => {
      const sealed = sealToken('gho_abc');
      expect(isSealedSecret(sealed)).toBe(true);
      if (isSealedSecret(sealed)) {
        expect(sealed.iv).toBeTruthy();
        expect(sealed.tag).toBeTruthy();
        expect(sealed.data).toBeTruthy();
      }
    });

    it('round-trips seal → unseal correctly', () => {
      const sealed = sealToken('gho_round_trip_12345');
      const plain = unsealToken(sealed);
      expect(plain).toBe('gho_round_trip_12345');
    });

    it('produces different ciphertext each time (random IV)', () => {
      const a = sealToken('same-plaintext') as { data: string };
      const b = sealToken('same-plaintext') as { data: string };
      expect(a.data).not.toBe(b.data);
    });

    it('isSealingEnabled reports true', () => {
      expect(isSealingEnabled()).toBe(true);
    });

    it('tampered ciphertext fails the GCM auth tag', () => {
      const sealed = sealToken('gho_sensitive') as { iv: string; tag: string; data: string; __sealed: true };
      // Flip the last byte of the ciphertext — should fail auth.
      const tampered = {
        ...sealed,
        data: Buffer.from(sealed.data, 'base64').map((b, i, arr) => i === arr.length - 1 ? b ^ 0x01 : b).toString('base64'),
      };
      expect(() => unsealToken(tampered)).toThrow();
    });

    it('unsealing with a different key fails', () => {
      const sealed = sealToken('gho_rotate_me');
      process.env.CDS_SECRET_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      expect(() => unsealToken(sealed)).toThrow();
    });
  });

  describe('with passphrase-derived key', () => {
    beforeEach(() => {
      // Non-hex, non-base64 string → SHA-256 derivation path
      process.env.CDS_SECRET_KEY = 'my-super-secret-passphrase';
    });

    it('still round-trips correctly', () => {
      const sealed = sealToken('gho_passphrase');
      expect(unsealToken(sealed)).toBe('gho_passphrase');
    });

    it('the same passphrase is deterministic across seals', () => {
      const sealedA = sealToken('unique');
      const sealedB = sealToken('unique');
      // IVs differ (random), but both should unseal with the same key
      expect(unsealToken(sealedA)).toBe('unique');
      expect(unsealToken(sealedB)).toBe('unique');
    });
  });

  describe('isSealedSecret type guard', () => {
    it('accepts a valid sealed object', () => {
      expect(isSealedSecret({ __sealed: true, iv: 'x', tag: 'y', data: 'z' })).toBe(true);
    });
    it('rejects plain strings', () => {
      expect(isSealedSecret('plain-token')).toBe(false);
    });
    it('rejects plain objects without __sealed flag', () => {
      expect(isSealedSecret({ iv: 'x', tag: 'y', data: 'z' })).toBe(false);
    });
    it('rejects null / undefined', () => {
      expect(isSealedSecret(null)).toBe(false);
      expect(isSealedSecret(undefined)).toBe(false);
    });
  });
});
