/**
 * Unit tests for the local username + password methods on AuthService,
 * exercised through a real MemoryAuthStore (no mongo, no native deps).
 *
 * Covers:
 *  - createLocalUser + verifyLocalLogin happy path
 *  - verifyLocalLogin rejects wrong password / unknown user / disabled account
 *  - duplicate username rejected
 *  - changePassword verifies old password, enforces min length, admin reset path
 *  - first-run bootstrap creates the system owner once, then refuses
 *  - activity record / query / per-user filter / newest-first / cap
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAuthStore, ACTIVITY_RING_CAPACITY } from '../../src/infra/auth-store/memory-store.js';
import { AuthService, LocalAuthError } from '../../src/services/auth-service.js';
import { GitHubOAuthClient } from '../../src/services/github-oauth-client.js';

function makeService(store: MemoryAuthStore): AuthService {
  // GitHub client is never exercised by the local-credential paths; provide a
  // dummy with throwing fetch so accidental OAuth calls fail loudly.
  const github = new GitHubOAuthClient({
    clientId: 'x',
    clientSecret: 'y',
    fetchImpl: async () => { throw new Error('github not used in local tests'); },
  });
  return new AuthService({ store, github, config: { allowedOrgs: [] } });
}

describe('AuthService local credentials', () => {
  let store: MemoryAuthStore;
  let svc: AuthService;

  beforeEach(() => {
    store = new MemoryAuthStore();
    svc = makeService(store);
  });

  it('creates a local user and logs in with the right password', async () => {
    const user = await svc.createLocalUser({ username: 'Alice', password: 'super-secret-1', name: 'Alice A' });
    expect(user.authProvider).toBe('local');
    expect(user.username).toBe('alice'); // lowercased
    expect(user.name).toBe('Alice A');
    // Password material is on the record but never plaintext.
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toContain('super-secret-1');

    const ok = await svc.verifyLocalLogin('alice', 'super-secret-1');
    expect(ok?.id).toBe(user.id);
    // Case-insensitive username.
    const ok2 = await svc.verifyLocalLogin('ALICE', 'super-secret-1');
    expect(ok2?.id).toBe(user.id);
  });

  it('rejects wrong password and unknown user (returns null, not throw)', async () => {
    await svc.createLocalUser({ username: 'bob', password: 'bobs-password-1' });
    expect(await svc.verifyLocalLogin('bob', 'wrong')).toBeNull();
    expect(await svc.verifyLocalLogin('nobody', 'whatever')).toBeNull();
  });

  it('rejects login for a disabled account', async () => {
    const user = await svc.createLocalUser({ username: 'carol', password: 'carols-password-1' });
    await svc.setUserStatus(user.id, 'disabled');
    expect(await svc.verifyLocalLogin('carol', 'carols-password-1')).toBeNull();
  });

  it('rejects duplicate username and invalid username/password', async () => {
    await svc.createLocalUser({ username: 'dave', password: 'daves-password-1' });
    await expect(svc.createLocalUser({ username: 'dave', password: 'another-pass-1' }))
      .rejects.toBeInstanceOf(LocalAuthError);
    await expect(svc.createLocalUser({ username: 'a', password: 'long-enough-1' }))
      .rejects.toMatchObject({ code: 'username_invalid' });
    await expect(svc.createLocalUser({ username: 'eve', password: 'short' }))
      .rejects.toMatchObject({ code: 'password_too_short' });
  });

  it('changePassword verifies old password and re-hashes', async () => {
    const user = await svc.createLocalUser({ username: 'frank', password: 'old-password-1' });
    await expect(svc.changePassword(user.id, 'wrong-old', 'new-password-2'))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    await svc.changePassword(user.id, 'old-password-1', 'new-password-2');
    expect(await svc.verifyLocalLogin('frank', 'old-password-1')).toBeNull();
    expect((await svc.verifyLocalLogin('frank', 'new-password-2'))?.id).toBe(user.id);
  });

  it('changePassword enforces min length and supports admin reset (no old pw)', async () => {
    const user = await svc.createLocalUser({ username: 'grace', password: 'old-password-1' });
    await expect(svc.changePassword(user.id, 'old-password-1', 'short'))
      .rejects.toMatchObject({ code: 'password_too_short' });
    // Admin reset path skips the old-password check.
    await svc.changePassword(user.id, '', 'reset-password-3', true);
    expect((await svc.verifyLocalLogin('grace', 'reset-password-3'))?.id).toBe(user.id);
  });

  it('changePassword refuses non-local accounts', async () => {
    // An OAuth user has no local credentials.
    const oauth = await store.upsertUser({
      githubId: 99, githubLogin: 'oauthy', email: null, name: 'OAuthy', avatarUrl: null, orgs: [],
    });
    await expect(svc.changePassword(oauth.id, 'x', 'new-password-1'))
      .rejects.toMatchObject({ code: 'not_local_account' });
  });

  it('first-run bootstrap mints the system owner exactly once', async () => {
    expect(await svc.hasAnyUser()).toBe(false);
    const owner = await svc.bootstrapFirstLocalUser({ username: 'root', password: 'root-password-1' });
    expect(owner.isSystemOwner).toBe(true);
    expect(owner.authProvider).toBe('local');
    // Second attempt must be refused now that a user exists.
    await expect(svc.bootstrapFirstLocalUser({ username: 'root2', password: 'root-password-2' }))
      .rejects.toBeInstanceOf(LocalAuthError);
  });
});

describe('AuthService user activity log', () => {
  let store: MemoryAuthStore;
  let svc: AuthService;

  beforeEach(() => {
    store = new MemoryAuthStore();
    svc = makeService(store);
  });

  it('records and queries activity newest-first', async () => {
    await svc.recordActivity({ userId: 'u1', userLogin: 'u1', action: 'login', summary: 'first' });
    await svc.recordActivity({ userId: 'u1', userLogin: 'u1', action: 'logout', summary: 'second' });
    const rows = await svc.listActivity();
    expect(rows).toHaveLength(2);
    expect(rows[0].summary).toBe('second'); // newest first
    expect(rows[1].summary).toBe('first');
  });

  it('filters activity by userId', async () => {
    await svc.recordActivity({ userId: 'u1', userLogin: 'u1', action: 'login', summary: 'a' });
    await svc.recordActivity({ userId: 'u2', userLogin: 'u2', action: 'login', summary: 'b' });
    const onlyU2 = await svc.listActivity({ userId: 'u2' });
    expect(onlyU2).toHaveLength(1);
    expect(onlyU2[0].userId).toBe('u2');
  });

  it('caps the ring buffer at ACTIVITY_RING_CAPACITY', async () => {
    const total = ACTIVITY_RING_CAPACITY + 50;
    for (let i = 0; i < total; i++) {
      await svc.recordActivity({ userId: 'u1', userLogin: 'u1', action: 'tick', summary: `n${i}` });
    }
    const all = await svc.listActivity({ limit: ACTIVITY_RING_CAPACITY });
    expect(all).toHaveLength(ACTIVITY_RING_CAPACITY);
    // The oldest 50 were evicted; newest is the last recorded.
    expect(all[0].summary).toBe(`n${total - 1}`);
    expect(all[all.length - 1].summary).toBe(`n${total - ACTIVITY_RING_CAPACITY}`);
  });
});
