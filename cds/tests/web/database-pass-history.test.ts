import { describe, expect, it } from 'vitest';
import { databasePassState } from '../../web/src/lib/databasePassState.js';

describe('database pass history and outstanding access', () => {
  it.each(['preparing', 'prepared', 'active', 'cleanup-failed'])(
    'keeps a %s pass actionable when a newer pass is reclaimed', status => {
      const outstanding = { id: 'retained', status };
      const reclaimed = { id: 'recent-test', status: 'revoked' };
      const state = databasePassState([outstanding, reclaimed]);
      expect(state.current).toBe(outstanding);
      expect(state.latest).toBe(reclaimed);
      expect(state.terminal).toBe(false);
    },
  );
  it('shows reapply guidance only after every outstanding pass is gone', () => {
    const before = [{ id: 'old', status: 'active' }, { id: 'new', status: 'expired' }];
    expect(databasePassState(before).terminal).toBe(false);
    const after = [{ ...before[0], status: 'expired' }, before[1]];
    expect(databasePassState(after)).toEqual({ current: undefined, latest: after[1], terminal: true });
  });
  it('selects the most recently issued outstanding pass and handles empty history', () => {
    const passes = [{ id: 'one', status: 'active' }, { id: 'two', status: 'prepared' }];
    expect(databasePassState(passes).current).toBe(passes[1]);
    expect(databasePassState([])).toEqual({ current: undefined, latest: undefined, terminal: false });
  });
});
