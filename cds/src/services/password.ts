/**
 * Local-credential password hashing — uses Node stdlib `node:crypto` scrypt
 * with a per-user random salt. No native dependency (bcrypt/argon2) is added
 * because this runtime cannot reliably build native modules; scrypt is a
 * memory-hard KDF shipped in Node core and is a sound choice for this scale.
 *
 * Security notes:
 *   - Each password gets a fresh 16-byte random salt.
 *   - Verification is constant-time via crypto.timingSafeEqual, and we guard
 *     against length-mismatch leaks by comparing only after deriving the same
 *     key length.
 *   - Password material (plaintext, salt, hash) is NEVER logged or returned to
 *     the client. Callers must keep `passwordHash`/`passwordSalt` server-side.
 *
 * Hash/salt are stored as hex strings on the CdsUser record.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt key length in bytes (64 = 512-bit derived key). */
const KEY_LEN = 64;
/** Salt length in bytes. */
const SALT_LEN = 16;
/** scrypt cost parameter N (CPU/memory). 2^14 is a sane interactive default. */
const SCRYPT_COST = 16384;

/** Minimum acceptable password length, enforced by callers. */
export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordHash {
  /** Hex-encoded derived key. */
  hash: string;
  /** Hex-encoded random salt. */
  salt: string;
}

/**
 * Hash a plaintext password with a fresh random salt. Returns hex-encoded
 * { hash, salt } for persistence on the user record.
 *
 * Throws if the password is shorter than MIN_PASSWORD_LENGTH so a weak
 * credential never reaches the store.
 */
export function hashPassword(plaintext: string): PasswordHash {
  if (typeof plaintext !== 'string' || plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(plaintext, salt, KEY_LEN, { N: SCRYPT_COST });
  return { hash: derived.toString('hex'), salt: salt.toString('hex') };
}

/**
 * Verify a candidate plaintext against a stored hex hash+salt. Constant-time.
 * Returns false (never throws) on any malformed input so callers can treat a
 * verification failure uniformly.
 */
export function verifyPassword(plaintext: string, stored: PasswordHash): boolean {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (!stored || typeof stored.hash !== 'string' || typeof stored.salt !== 'string') return false;

  let saltBuf: Buffer;
  let storedHashBuf: Buffer;
  try {
    saltBuf = Buffer.from(stored.salt, 'hex');
    storedHashBuf = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  if (saltBuf.length === 0 || storedHashBuf.length === 0) return false;

  let candidate: Buffer;
  try {
    candidate = scryptSync(plaintext, saltBuf, storedHashBuf.length, { N: SCRYPT_COST });
  } catch {
    return false;
  }
  // Lengths are equal by construction (derive to storedHashBuf.length), so
  // timingSafeEqual is safe to call directly.
  if (candidate.length !== storedHashBuf.length) return false;
  return timingSafeEqual(candidate, storedHashBuf);
}
