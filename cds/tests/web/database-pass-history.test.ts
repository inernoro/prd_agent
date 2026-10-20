import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyDatabasePassCredentials, databasePassState } from '../../web/src/lib/databasePassState.js';

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

describe('database pass clipboard recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('confirms completed copies and clears the deadline', async () => {
    vi.useFakeTimers();
    await expect(copyDatabasePassCredentials(() => Promise.resolve())).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a pending background copy after five seconds without claiming success', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = copyDatabasePassCredentials(() => new Promise<void>(resolve => { finish = resolve; }));
    const rejected = expect(pending).rejects.toThrow('请保持当前页在前台');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    finish();
    await expect(pending).rejects.toThrow('未能确认连接信息已复制');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps browser diagnostics and copied secrets out of permission errors', async () => {
    await expect(copyDatabasePassCredentials(() => Promise.reject(new Error('NotAllowedError secret-password'))))
      .rejects.toThrow(/^未能确认连接信息已复制。请保持当前页在前台，并允许剪贴板访问后重试；也可先撤销通行证。$/);
  });
});
