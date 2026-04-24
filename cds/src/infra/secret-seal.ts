/**
 * FU-05: lightweight at-rest encryption for single-slot secrets like
 * the GitHub Device Flow token stored in state.json.
 *
 * Design: AES-256-GCM (authenticated encryption) with a key derived
 * from the `CDS_SECRET_KEY` env var. When `CDS_SECRET_KEY` is not set,
 * these helpers become no-ops — tokens are written as plaintext
 * strings, matching the pre-FU-05 behaviour. This keeps the contract
 * backwards-compatible for operators who don't care.
 *
 * Why bother? state.json used to hold `githubDeviceAuth.token` in
 * plaintext. If the file was accidentally committed to git or leaked
 * in a backup archive, the token was instantly usable by anyone who
 * read it. AES-256-GCM means a leaked state.json without the matching
 * CDS_SECRET_KEY is cryptographically useless.
 *
 * Backwards compat: legacy plaintext tokens still unseal fine (see
 * unsealToken's string short-circuit). The two formats can coexist in
 * the same file — on write we encrypt if a key is available, on read
 * we handle both. This makes rollout painless: set the key, restart
 * CDS, do one Device Flow → the saved token is now sealed; all old
 * data stays intact.
 */

import crypto from 'node:crypto';

export interface SealedSecret {
  __sealed: true;
  /** Base64-encoded 12-byte IV */
  iv: string;
  /** Base64-encoded 16-byte auth tag */
  tag: string;
  /** Base64-encoded ciphertext */
  data: string;
}

export function isSealedSecret(x: unknown): x is SealedSecret {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { __sealed?: unknown }).__sealed === true
  );
}

/**
 * Resolve the AES-256-GCM key from the `CDS_SECRET_KEY` env var.
 * Accepts three formats:
 *   1. 64 hex chars (32 bytes)  — most common, matches `openssl rand -hex 32`
 *   2. Base64 that decodes to ≥ 32 bytes — use the first 32
 *   3. Anything else — SHA-256 digest of the UTF-8 bytes (lets users
 *      set a human-readable passphrase; slightly weaker but still fine
 *      for a single-key AEAD scheme)
 *
 * Returns null when the env var is unset, which callers interpret as
 * "no encryption available, fall back to plaintext".
 */
function resolveKey(): Buffer | null {
  const raw = process.env.CDS_SECRET_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length >= 32) return b64.subarray(0, 32);
  } catch {
    // Fall through to passphrase derivation
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/**
 * Seal a plaintext secret. Returns:
 *   - plain string unchanged if CDS_SECRET_KEY is not set
 *   - a {@link SealedSecret} object if the key is present
 */
export function sealToken(plain: string): string | SealedSecret {
  const key = resolveKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    __sealed: true,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

/**
 * Unseal a token that may be plaintext (legacy) or a {@link SealedSecret}.
 * Throws if the input is sealed but the key isn't available — caller
 * must decide whether to drop the token or surface the error.
 */
export function unsealToken(stored: unknown): string {
  if (typeof stored === 'string') return stored;
  if (!isSealedSecret(stored)) {
    throw new Error('Invalid sealed secret shape');
  }
  const key = resolveKey();
  if (!key) {
    throw new Error(
      'Sealed token cannot be unsealed: CDS_SECRET_KEY is not set. ' +
      'If you removed the key, reset the Device Flow login in Settings → GitHub.',
    );
  }
  const iv = Buffer.from(stored.iv, 'base64');
  const tag = Buffer.from(stored.tag, 'base64');
  const data = Buffer.from(stored.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Helper: is encryption actually active right now? Used by the Settings
 * page to display a "tokens are encrypted" badge when the operator has
 * configured CDS_SECRET_KEY.
 */
export function isSealingEnabled(): boolean {
  return resolveKey() !== null;
}
