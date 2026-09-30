import { describe, expect, it } from 'vitest';

import { isHumanSystemOwner } from '../../src/services/human-auth.js';

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
