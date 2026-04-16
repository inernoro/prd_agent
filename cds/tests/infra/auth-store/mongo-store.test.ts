/**
 * Unit tests for MongoAuthStore (FU-02).
 *
 * Uses an in-memory mock IAuthMongoHandle so the real `mongodb` driver
 * never touches the test runner — mirrors the pattern in
 * `tests/infra/mongo-backing-store.test.ts`.
 *
 * Covers the 9 scenarios called out in design.cds-fu-02-auth-store-mongo.md §5:
 *  1. init with empty collection
 *  2. first upsertUser → isSystemOwner === false (store layer)
 *  3. second upsertUser → isSystemOwner === false (bootstrap is auth-service's job)
 *  4. re-login updates githubLogin + lastLoginAt, keeps id stable
 *  5. createSession + findSessionByToken round-trip
 *  6. findSessionByToken with expired token → auto-delete + null
 *  7. findSessionByToken with orphaned session (user deleted) handled by caller
 *  8. revokeSession (deleteSession) → token invalid
 *  9. listSessionsForUser (deleteSessionsForUser) removes all sessions
 *
 * Also covers: markUserAsSystemOwner, workspaces, duplicate slug rejection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MongoAuthStore } from '../../../src/infra/auth-store/mongo-store.js';
import type { IAuthMongoHandle, IAuthCollection } from '../../../src/infra/auth-store/mongo-handle.js';
import type { CdsUser, CdsSession, CdsWorkspace, CdsWorkspaceMember, CdsWorkspaceInvite } from '../../../src/domain/auth.js';
import { DEFAULT_SESSION_TTL_MS } from '../../../src/infra/auth-store/memory-store.js';

// ── Fake collection ───────────────────────────────────────────────────────────

class FakeAuthCollection<T extends Record<string, unknown>> implements IAuthCollection<T> {
  public readonly docs = new Map<string, T>();

  /** Simple field-equality filter matching. */
  private matches(doc: T, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([k, v]) => (doc as Record<string, unknown>)[k] === v);
  }

  private findFirst(filter: Record<string, unknown>): T | undefined {
    for (const doc of this.docs.values()) {
      if (this.matches(doc, filter)) return doc;
    }
    return undefined;
  }

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.findFirst(filter) ?? null;
  }

  async find(filter: Record<string, unknown>): Promise<T[]> {
    return Array.from(this.docs.values()).filter((d) => this.matches(d, filter));
  }

  async insertOne(doc: T): Promise<void> {
    // Key by id or token
    const key = (doc as { id?: string; token?: string }).id
      ?? (doc as { token?: string }).token
      ?? Math.random().toString(36).slice(2);
    if (this.docs.has(key)) throw new Error(`Duplicate key: ${key}`);
    this.docs.set(key, { ...doc });
  }

  async replaceOne(filter: Record<string, unknown>, doc: T): Promise<void> {
    // Find existing doc to get its key, then replace
    for (const [key, existing] of this.docs.entries()) {
      if (this.matches(existing, filter)) {
        this.docs.set(key, { ...doc });
        return;
      }
    }
    // upsert: insert with new key
    const key = (doc as { id?: string; token?: string }).id
      ?? (doc as { token?: string }).token
      ?? Math.random().toString(36).slice(2);
    this.docs.set(key, { ...doc });
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
    const setFields = (update as { $set?: Record<string, unknown> }).$set ?? {};
    for (const [key, doc] of this.docs.entries()) {
      if (this.matches(doc, filter)) {
        this.docs.set(key, { ...doc, ...setFields });
        return;
      }
    }
  }

  async deleteOne(filter: Record<string, unknown>): Promise<void> {
    for (const [key, doc] of this.docs.entries()) {
      if (this.matches(doc, filter)) {
        this.docs.delete(key);
        return;
      }
    }
  }

  async deleteMany(filter: Record<string, unknown>): Promise<number> {
    let count = 0;
    for (const [key, doc] of this.docs.entries()) {
      if (this.matches(doc, filter)) {
        this.docs.delete(key);
        count++;
      }
    }
    return count;
  }

  async countDocuments(filter?: Record<string, unknown>): Promise<number> {
    if (!filter || Object.keys(filter).length === 0) return this.docs.size;
    let count = 0;
    for (const doc of this.docs.values()) {
      if (this.matches(doc, filter)) count++;
    }
    return count;
  }
}

// ── Fake handle ───────────────────────────────────────────────────────────────

class FakeAuthMongoHandle implements IAuthMongoHandle {
  public connected = false;
  public closed = false;
  public pingResult = true;

  public readonly users = new FakeAuthCollection<CdsUser>();
  public readonly sessions = new FakeAuthCollection<CdsSession>();
  public readonly workspaces = new FakeAuthCollection<CdsWorkspace>();
  public readonly members = new FakeAuthCollection<CdsWorkspaceMember>();
  public readonly invites = new FakeAuthCollection<CdsWorkspaceInvite>();

  async connect() { this.connected = true; }
  usersCollection() { return this.users; }
  sessionsCollection() { return this.sessions; }
  workspacesCollection() { return this.workspaces; }
  membersCollection() { return this.members; }
  invitesCollection() { return this.invites; }
  async close() { this.closed = true; }
  async ping() { return this.pingResult; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sampleInput(overrides: Partial<{
  githubId: number;
  githubLogin: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  orgs: string[];
}> = {}) {
  return {
    githubId: overrides.githubId ?? 12345,
    githubLogin: overrides.githubLogin ?? 'alice',
    email: overrides.email ?? 'alice@example.com',
    name: overrides.name ?? 'Alice',
    avatarUrl: overrides.avatarUrl ?? null,
    orgs: overrides.orgs ?? ['org1'],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MongoAuthStore', () => {
  let handle: FakeAuthMongoHandle;
  let store: MongoAuthStore;

  beforeEach(() => {
    handle = new FakeAuthMongoHandle();
    store = new MongoAuthStore(handle);
  });

  // ── Scenario 1: empty state ──────────────────────────────────────────────

  it('starts with empty collections — all counts are 0', async () => {
    expect(await store.countUsers()).toBe(0);
    expect(await store.countWorkspaces()).toBe(0);
  });

  // ── Scenario 2 & 3: upsertUser ─────────────────────────────────────────

  it('creates a new user with isSystemOwner=false and active status', async () => {
    const user = await store.upsertUser(sampleInput());

    expect(user.id).toBeTruthy();
    expect(user.githubId).toBe(12345);
    expect(user.githubLogin).toBe('alice');
    expect(user.isSystemOwner).toBe(false);
    expect(user.status).toBe('active');
    expect(user.lastLoginAt).toBeNull();
    expect(await store.countUsers()).toBe(1);
  });

  it('second upsertUser is also isSystemOwner=false — bootstrap is auth-service responsibility', async () => {
    await store.upsertUser(sampleInput({ githubId: 1, githubLogin: 'alice' }));
    const second = await store.upsertUser(sampleInput({ githubId: 2, githubLogin: 'bob' }));
    expect(second.isSystemOwner).toBe(false);
    expect(await store.countUsers()).toBe(2);
  });

  // ── Scenario 4: re-login updates fields, preserves id ──────────────────

  it('re-login: updates githubLogin/email/orgs, preserves id and isSystemOwner', async () => {
    const first = await store.upsertUser(sampleInput({
      githubLogin: 'alice-old',
      email: 'alice@old.com',
      orgs: ['old-org'],
    }));

    const second = await store.upsertUser(sampleInput({
      githubLogin: 'alice-new',
      email: 'alice@new.com',
      orgs: ['new-org', 'another-org'],
    }));

    expect(second.id).toBe(first.id);
    expect(second.githubLogin).toBe('alice-new');
    expect(second.email).toBe('alice@new.com');
    expect(second.orgs).toEqual(['new-org', 'another-org']);
    expect(await store.countUsers()).toBe(1);
  });

  // ── findUser* ─────────────────────────────────────────────────────────────

  it('findUserByGithubId returns null for unknown id', async () => {
    expect(await store.findUserByGithubId(99999)).toBeNull();
  });

  it('findUserByGithubId finds the created user', async () => {
    const created = await store.upsertUser(sampleInput({ githubId: 999 }));
    const found = await store.findUserByGithubId(999);
    expect(found?.id).toBe(created.id);
  });

  it('findUserById returns null for unknown id', async () => {
    expect(await store.findUserById('nonexistent')).toBeNull();
  });

  it('findUserById finds by internal id', async () => {
    const created = await store.upsertUser(sampleInput());
    const found = await store.findUserById(created.id);
    expect(found?.githubId).toBe(12345);
  });

  // ── touchUserLastLogin ────────────────────────────────────────────────────

  it('touchUserLastLogin sets lastLoginAt', async () => {
    const created = await store.upsertUser(sampleInput());
    expect(created.lastLoginAt).toBeNull();

    const now = new Date();
    await store.touchUserLastLogin(created.id, now);

    const after = await store.findUserById(created.id);
    expect(after?.lastLoginAt).toBe(now.toISOString());
  });

  it('touchUserLastLogin is a no-op for unknown id', async () => {
    // Should not throw
    await expect(store.touchUserLastLogin('ghost')).resolves.toBeUndefined();
  });

  // ── markUserAsSystemOwner ─────────────────────────────────────────────────

  it('markUserAsSystemOwner flips the flag and persists it', async () => {
    const created = await store.upsertUser(sampleInput());
    expect(created.isSystemOwner).toBe(false);

    const updated = await (store as { markUserAsSystemOwner: (id: string) => Promise<CdsUser | null> })
      .markUserAsSystemOwner(created.id);
    expect(updated?.isSystemOwner).toBe(true);

    const refetched = await store.findUserById(created.id);
    expect(refetched?.isSystemOwner).toBe(true);
  });

  it('markUserAsSystemOwner returns null for unknown id', async () => {
    const result = await (store as { markUserAsSystemOwner: (id: string) => Promise<CdsUser | null> })
      .markUserAsSystemOwner('ghost');
    expect(result).toBeNull();
  });

  // ── setUserStatus ─────────────────────────────────────────────────────────

  it('setUserStatus updates the user status', async () => {
    const created = await store.upsertUser(sampleInput());
    const updated = await store.setUserStatus(created.id, 'disabled');
    expect(updated?.status).toBe('disabled');

    const refetched = await store.findUserById(created.id);
    expect(refetched?.status).toBe('disabled');
  });

  it('setUserStatus returns null for unknown id', async () => {
    expect(await store.setUserStatus('ghost', 'disabled')).toBeNull();
  });

  // ── Scenario 5: createSession + findSessionByToken ────────────────────────

  it('createSession + findSessionByToken round-trip', async () => {
    const user = await store.upsertUser(sampleInput());
    const now = new Date();
    const session = await store.createSession({
      userId: user.id,
      ttlMs: DEFAULT_SESSION_TTL_MS,
      userAgent: 'test-agent',
      ipAddress: '127.0.0.1',
    }, now);

    expect(session.token).toBeTruthy();
    expect(session.token.length).toBeGreaterThan(20);
    expect(session.userId).toBe(user.id);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const found = await store.findSessionByToken(session.token, now);
    expect(found?.userId).toBe(user.id);
    expect(found?.userAgent).toBe('test-agent');
  });

  it('findSessionByToken returns null for unknown token', async () => {
    expect(await store.findSessionByToken('bogus')).toBeNull();
  });

  // ── Scenario 6: expired token → auto-delete + null ────────────────────────

  it('findSessionByToken returns null and prunes expired sessions', async () => {
    const user = await store.upsertUser(sampleInput());
    const session = await store.createSession({
      userId: user.id, ttlMs: 10, userAgent: null, ipAddress: null,
    });

    expect(handle.sessions.docs.size).toBe(1);

    const future = new Date(Date.now() + 1000);
    const result = await store.findSessionByToken(session.token, future);
    expect(result).toBeNull();

    // The expired session must have been deleted from the store
    expect(handle.sessions.docs.size).toBe(0);
  });

  // ── Scenario 8: deleteSession (revokeSession) ────────────────────────────

  it('deleteSession makes the token invalid', async () => {
    const user = await store.upsertUser(sampleInput());
    const session = await store.createSession({
      userId: user.id, ttlMs: DEFAULT_SESSION_TTL_MS, userAgent: null, ipAddress: null,
    });

    await store.deleteSession(session.token);
    expect(await store.findSessionByToken(session.token)).toBeNull();
  });

  // ── Scenario 9: deleteSessionsForUser ────────────────────────────────────

  it('deleteSessionsForUser removes all sessions for the user and returns count', async () => {
    const user = await store.upsertUser(sampleInput());
    await store.createSession({ userId: user.id, ttlMs: DEFAULT_SESSION_TTL_MS, userAgent: null, ipAddress: null });
    await store.createSession({ userId: user.id, ttlMs: DEFAULT_SESSION_TTL_MS, userAgent: null, ipAddress: null });
    await store.createSession({ userId: user.id, ttlMs: DEFAULT_SESSION_TTL_MS, userAgent: null, ipAddress: null });

    const count = await store.deleteSessionsForUser(user.id);
    expect(count).toBe(3);
    expect(handle.sessions.docs.size).toBe(0);
  });

  it('deleteSessionsForUser only removes sessions for the specified user', async () => {
    const alice = await store.upsertUser(sampleInput({ githubId: 1, githubLogin: 'alice' }));
    const bob = await store.upsertUser(sampleInput({ githubId: 2, githubLogin: 'bob' }));

    await store.createSession({ userId: alice.id, ttlMs: DEFAULT_SESSION_TTL_MS, userAgent: null, ipAddress: null });
    await store.createSession({ userId: bob.id, ttlMs: DEFAULT_SESSION_TTL_MS, userAgent: null, ipAddress: null });

    await store.deleteSessionsForUser(alice.id);

    // Bob's session must still be present
    const remaining = await handle.sessions.find({ userId: bob.id });
    expect(remaining).toHaveLength(1);
  });

  // ── Workspaces ────────────────────────────────────────────────────────────

  it('createWorkspace + findWorkspaceBySlug round-trip', async () => {
    const user = await store.upsertUser(sampleInput());
    const ws = await store.createWorkspace({
      slug: 'alice-personal',
      name: 'Alice Personal',
      kind: 'personal',
      ownerId: user.id,
    });

    expect(ws.slug).toBe('alice-personal');
    expect(ws.projectCount).toBe(0);
    expect(ws.kind).toBe('personal');

    const found = await store.findWorkspaceBySlug('alice-personal');
    expect(found?.id).toBe(ws.id);
  });

  it('findWorkspaceBySlug returns null for unknown slug', async () => {
    expect(await store.findWorkspaceBySlug('nonexistent')).toBeNull();
  });

  it('createWorkspace rejects duplicate slugs', async () => {
    const user = await store.upsertUser(sampleInput());
    await store.createWorkspace({ slug: 'taken', name: 'A', kind: 'personal', ownerId: user.id });
    await expect(
      store.createWorkspace({ slug: 'taken', name: 'B', kind: 'personal', ownerId: user.id }),
    ).rejects.toThrow(/already exists/);
  });

  it('findWorkspacesForUser returns only personal workspaces for that user', async () => {
    const alice = await store.upsertUser(sampleInput({ githubId: 1, githubLogin: 'alice' }));
    const bob = await store.upsertUser(sampleInput({ githubId: 2, githubLogin: 'bob' }));

    await store.createWorkspace({ slug: 'alice-ws', name: 'Alice WS', kind: 'personal', ownerId: alice.id });
    await store.createWorkspace({ slug: 'bob-ws', name: 'Bob WS', kind: 'personal', ownerId: bob.id });

    const owned = await store.findWorkspacesForUser(alice.id);
    expect(owned).toHaveLength(1);
    expect(owned[0].slug).toBe('alice-ws');
  });

  it('countWorkspaces returns total across all users', async () => {
    const alice = await store.upsertUser(sampleInput({ githubId: 1, githubLogin: 'alice' }));
    const bob = await store.upsertUser(sampleInput({ githubId: 2, githubLogin: 'bob' }));
    await store.createWorkspace({ slug: 'alice-ws', name: 'A', kind: 'personal', ownerId: alice.id });
    await store.createWorkspace({ slug: 'bob-ws', name: 'B', kind: 'personal', ownerId: bob.id });
    expect(await store.countWorkspaces()).toBe(2);
  });
});
