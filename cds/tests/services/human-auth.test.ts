import { describe, expect, it } from 'vitest';

import { isAuthenticatedHuman, isHumanSystemOwner } from '../../src/services/human-auth.js';

describe('isAuthenticatedHuman', () => {
  it('accepts persisted local, GitHub, SSO, and legacy human sessions', () => {
    for (const authProvider of ['local', 'github', 'sso']) {
      expect(isAuthenticatedHuman({
        cdsUser: { username: 'human', authProvider },
        cdsSession: { id: `${authProvider}-session` },
      })).toBe(true);
    }
    expect(isAuthenticatedHuman({
      _cdsBasicHumanAuth: true,
      cdsUser: { username: 'legacy', authProvider: 'legacy' },
    })).toBe(true);
  });

  it('rejects marker-only, user-only, session-only, and machine requests', () => {
    expect(isAuthenticatedHuman({ _cdsBasicHumanAuth: true })).toBe(false);
    expect(isAuthenticatedHuman({ cdsUser: { username: 'detached' } })).toBe(false);
    expect(isAuthenticatedHuman({ cdsSession: { id: 'detached' } })).toBe(false);
    expect(isAuthenticatedHuman({ _cdsCookieAuth: true })).toBe(false);
    expect(isAuthenticatedHuman({})).toBe(false);
  });
});

describe('isHumanSystemOwner', () => {
  it('accepts persisted and legacy system-owner sessions', () => {
    expect(isHumanSystemOwner({
      cdsUser: { isSystemOwner: true, authProvider: 'local' },
      cdsSession: { id: 'persisted-session' },
    })).toBe(true);
    expect(isHumanSystemOwner({
      _cdsBasicHumanAuth: true,
      cdsUser: { isSystemOwner: true, authProvider: 'legacy' },
    })).toBe(true);
  });

  it('rejects ordinary users, SSO identities, marker-only requests, and machines', () => {
    expect(isHumanSystemOwner({
      cdsUser: { isSystemOwner: false, authProvider: 'local' },
      cdsSession: { id: 'member-session' },
    })).toBe(false);
    expect(isHumanSystemOwner({
      cdsUser: { isSystemOwner: true, authProvider: 'sso' },
      cdsSession: { id: 'sso-session' },
    })).toBe(false);
    expect(isHumanSystemOwner({ _cdsCookieAuth: true })).toBe(false);
    expect(isHumanSystemOwner({})).toBe(false);
  });
});
