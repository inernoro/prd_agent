import { describe, expect, it } from 'vitest';

import { canQuickStartBranch } from '../../web/src/lib/branch-quick-actions.js';

describe('canQuickStartBranch', () => {
  it('allows a stopped branch to start directly from its card', () => {
    expect(canQuickStartBranch({
      status: 'idle',
      services: { web: { status: 'stopped' }, api: { status: 'stopped' } },
    })).toBe(true);
  });

  it('does not treat never-deployed, active, or failed branches as quick-startable', () => {
    expect(canQuickStartBranch({ status: 'idle', services: {} })).toBe(false);
    expect(canQuickStartBranch({
      status: 'idle',
      services: { web: { status: 'stopped' }, api: { status: 'starting' } },
    })).toBe(false);
    expect(canQuickStartBranch({
      status: 'error',
      services: { web: { status: 'stopped' } },
    })).toBe(false);
  });
});
