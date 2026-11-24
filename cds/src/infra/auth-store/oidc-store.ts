import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { Adapter, AdapterPayload } from 'oidc-provider';

export interface OidcArtifact {
  _id: string;
  model?: string;
  payload?: AdapterPayload;
  expiresAt?: Date;
  key?: ReturnType<typeof createSigningMaterial>;
  authorization?: { siteId: string; revision: string; cdsToken: string };
  browser?: { sessions: Record<string, string>; preferences: Record<string, string> };
}

function createSigningMaterial() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    jwk: { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: randomUUID() },
    cookieKey: randomBytes(48).toString('base64url'),
  };
}

/** Only called when the CDS identity provider is configured on this authority. */
export async function loadOidcSigningMaterial(store: Collection<OidcArtifact>) {
  const selector = { _id: 'signing-material' };
  const existing = await store.findOne(selector);
  if (existing?.key) return existing.key;
  try {
    const stored = await store.findOneAndUpdate(selector, { $setOnInsert: { key: createSigningMaterial() } }, { upsert: true, returnDocument: 'after' });
    if (stored?.key) return stored.key;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const winner = await store.findOne(selector);
    if (winner?.key) return winner.key;
  }
  throw new Error('Unable to initialize CDS signing keys');
}

export function mongoOidcAdapter(store: Collection<OidcArtifact>, client: (id: string) => AdapterPayload | undefined) {
  // The authority also enforces expiry on reads. The bounded sweep retains
  // signing material and lets the same store run without a deployment-time migration.
  let nextSweep = 0;
  return (model: string): Adapter => {
    const key = (id: string) => `${model}:${id}`;
    const live = () => ({ expiresAt: { $gt: new Date() } });
    return {
      async upsert(id, payload, expiresIn) {
        const row = { model, payload, expiresAt: new Date(Date.now() + (expiresIn ?? 8 * 60 * 60) * 1000) };
        await store.updateOne({ _id: key(id) }, { $set: row }, { upsert: true });
        if (Date.now() >= nextSweep) {
          nextSweep = Date.now() + 60_000;
          void store.deleteMany({ expiresAt: { $lte: new Date() } }).catch(() => undefined);
        }
      },
      async find(id) {
        if (model === 'Client') return client(id);
        return (await store.findOne({ _id: key(id), ...live() }))?.payload;
      },
      async findByUserCode(userCode) {
        return (await store.findOne({ model, 'payload.userCode': userCode, ...live() }))?.payload;
      },
      async findByUid(uid) {
        return (await store.findOne({ model, 'payload.uid': uid, ...live() }))?.payload;
      },
      async consume(id) {
        const update = await store.updateOne({ _id: key(id), 'payload.consumed': { $exists: false }, ...live() },
          { $set: { 'payload.consumed': Math.floor(Date.now() / 1000) } });
        if (update.matchedCount !== 1) {
          const { errors } = await import('oidc-provider');
          throw new errors.InvalidGrant('Authorization no longer available');
        }
      },
      async destroy(id) { await store.deleteOne({ _id: key(id) }); },
      async revokeByGrantId(grantId) { await store.deleteMany({ model, 'payload.grantId': grantId }); },
    };
  };
}
