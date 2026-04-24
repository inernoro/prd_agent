import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAuthStore, DEFAULT_SESSION_TTL_MS } from '../../src/infra/auth-store/memory-store.js';

describe('MemoryAuthStore', () => {
  let store: MemoryAuthStore;

  beforeEach(() => {
    store = new MemoryAuthStore();
  });

  describe('upsertUser', () => {
    it('creates a new user with a generated id and default status', async () => {
      const user = await store.upsertUser({
        githubId: 12345,
        githubLogin: 'alice',
        email: 'alice@example.com',
        name: 'Alice',
        avatarUrl: 'https://example.com/a.png',
        orgs: ['org1', 'org2'],
      });

      expect(user.id).toBeTruthy();
      expect(user.id.length).toBeGreaterThan(10);
      expect(user.githubId).toBe(12345);
      expect(user.githubLogin).toBe('alice');
      expect(user.status).toBe('active');
      expect(user.isSystemOwner).toBe(false);
      expect(user.orgs).toEqual(['org1', 'org2']);
      expect(user.lastLoginAt).toBeNull();
    });

    it('updates an existing user when githubId matches and preserves id', async () => {
      const first = await store.upsertUser({
        githubId: 12345,
        githubLogin: 'alice',
        email: 'alice@old.com',
        name: 'Alice Old',
        avatarUrl: null,
        orgs: ['org1'],
      });

      const second = await store.upsertUser({
        githubId: 12345,
        githubLogin: 'alice',
        email: 'alice@new.com',
        name: 'Alice New',
        avatarUrl: 'https://new.avatar',
        orgs: ['org1', 'org2'],
      });

      expect(second.id).toBe(first.id);
      expect(second.email).toBe('alice@new.com');
      expect(second.name).toBe('Alice New');
      expect(second.avatarUrl).toBe('https://new.avatar');
      expect(second.orgs).toEqual(['org1', 'org2']);
      expect(await store.countUsers()).toBe(1);
    });
  });

  describe('findUser*', () => {
    it('finds user by github id', async () => {
      const created = await store.upsertUser({
        githubId: 999,
        githubLogin: 'bob',
        email: null,
        name: 'Bob',
        avatarUrl: null,
        orgs: [],
      });
      const found = await store.findUserByGithubId(999);
      expect(found?.id).toBe(created.id);
    });

    it('returns null for unknown github id', async () => {
      expect(await store.findUserByGithubId(42)).toBeNull();
    });

    it('finds user by internal id', async () => {
      const created = await store.upsertUser({
        githubId: 1,
        githubLogin: 'x',
        email: null,
        name: 'X',
        avatarUrl: null,
        orgs: [],
      });
      const found = await store.findUserById(created.id);
      expect(found?.githubId).toBe(1);
    });
  });

  describe('touchUserLastLogin', () => {
    it('sets lastLoginAt', async () => {
      const created = await store.upsertUser({
        githubId: 1,
        githubLogin: 'x',
        email: null,
        name: 'X',
        avatarUrl: null,
        orgs: [],
      });
      expect(created.lastLoginAt).toBeNull();

      await store.touchUserLastLogin(created.id);
      const after = await store.findUserById(created.id);
      expect(after?.lastLoginAt).toBeTruthy();
    });
  });

  describe('markUserAsSystemOwner', () => {
    it('flips the isSystemOwner flag', async () => {
      const created = await store.upsertUser({
        githubId: 1,
        githubLogin: 'x',
        email: null,
        name: 'X',
        avatarUrl: null,
        orgs: [],
      });
      expect(created.isSystemOwner).toBe(false);

      const updated = await store.markUserAsSystemOwner(created.id);
      expect(updated?.isSystemOwner).toBe(true);

      const refetched = await store.findUserById(created.id);
      expect(refetched?.isSystemOwner).toBe(true);
    });
  });

  describe('sessions', () => {
    it('creates a session with token and default TTL', async () => {
      const user = await store.upsertUser({
        githubId: 1, githubLogin: 'x', email: null, name: 'X', avatarUrl: null, orgs: [],
      });
      const session = await store.createSession({
        userId: user.id,
        ttlMs: DEFAULT_SESSION_TTL_MS,
        userAgent: 'test',
        ipAddress: '127.0.0.1',
      });
      expect(session.token).toBeTruthy();
      expect(session.token.length).toBeGreaterThan(20);
      expect(session.userId).toBe(user.id);
      expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('findSessionByToken returns null for unknown token', async () => {
      expect(await store.findSessionByToken('bogus')).toBeNull();
    });

    it('findSessionByToken returns null and prunes for expired token', async () => {
      const user = await store.upsertUser({
        githubId: 1, githubLogin: 'x', email: null, name: 'X', avatarUrl: null, orgs: [],
      });
      const session = await store.createSession({
        userId: user.id,
        ttlMs: 10,
        userAgent: null,
        ipAddress: null,
      });
      // Fast-forward by passing a future "now"
      const future = new Date(Date.now() + 1000);
      const result = await store.findSessionByToken(session.token, future);
      expect(result).toBeNull();
    });

    it('deleteSessionsForUser removes all user sessions', async () => {
      const user = await store.upsertUser({
        githubId: 1, githubLogin: 'x', email: null, name: 'X', avatarUrl: null, orgs: [],
      });
      await store.createSession({ userId: user.id, ttlMs: 1_000_000, userAgent: null, ipAddress: null });
      await store.createSession({ userId: user.id, ttlMs: 1_000_000, userAgent: null, ipAddress: null });
      await store.createSession({ userId: user.id, ttlMs: 1_000_000, userAgent: null, ipAddress: null });

      const count = await store.deleteSessionsForUser(user.id);
      expect(count).toBe(3);
    });
  });

  describe('workspaces', () => {
    it('creates and finds a personal workspace', async () => {
      const user = await store.upsertUser({
        githubId: 1, githubLogin: 'alice', email: null, name: 'Alice', avatarUrl: null, orgs: [],
      });
      const ws = await store.createWorkspace({
        slug: 'alice-personal',
        name: 'Alice Personal',
        kind: 'personal',
        ownerId: user.id,
      });
      expect(ws.slug).toBe('alice-personal');
      expect(ws.projectCount).toBe(0);

      const found = await store.findWorkspaceBySlug('alice-personal');
      expect(found?.id).toBe(ws.id);

      const owned = await store.findWorkspacesForUser(user.id);
      expect(owned).toHaveLength(1);
      expect(owned[0].slug).toBe('alice-personal');
    });

    it('rejects duplicate slugs', async () => {
      const user = await store.upsertUser({
        githubId: 1, githubLogin: 'x', email: null, name: 'X', avatarUrl: null, orgs: [],
      });
      await store.createWorkspace({
        slug: 'taken', name: 'A', kind: 'personal', ownerId: user.id,
      });
      await expect(
        store.createWorkspace({ slug: 'taken', name: 'B', kind: 'personal', ownerId: user.id }),
      ).rejects.toThrow(/already exists/);
    });
  });
});
