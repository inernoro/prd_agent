import { describe, expect, it } from 'vitest';
import {
  isGitHubConnectionBroken, connectionBrokenHint,
  shouldResumeAtRepoStep, nextStepAfterAuthLoad, revokedConnectionHint,
  replacingConnectionNotice, connectionHeaderLabel,
} from './githubConnectionState';

describe('GitHub 连接状态判据', () => {
  it('连接类错误码要认出来，并给得出下一步', () => {
    expect(isGitHubConnectionBroken('GITHUB_TOKEN_EXPIRED')).toBe(true);
    expect(isGitHubConnectionBroken('GITHUB_NOT_CONNECTED')).toBe(true);
    expect(connectionBrokenHint('GITHUB_TOKEN_EXPIRED')).toContain('重新授权');
    expect(connectionBrokenHint('GITHUB_NOT_CONNECTED')).toContain('重新授权');
  });

  it('其它错误不算连接坏了——不能一报错就劝人重连', () => {
    // 仓库不可见是权限/路径问题，重连一次也还是看不见，给错出口会把人带偏
    expect(isGitHubConnectionBroken('GITHUB_REPO_NOT_VISIBLE')).toBe(false);
    expect(isGitHubConnectionBroken('GITHUB_RATE_LIMITED')).toBe(false);
    expect(isGitHubConnectionBroken(undefined)).toBe(false);
    expect(isGitHubConnectionBroken(null)).toBe(false);
    expect(connectionBrokenHint('GITHUB_RATE_LIMITED')).toBeNull();
  });
});

describe('进门时该停在哪一步', () => {
  it('连着且 GitHub 还认 —— 直接跳到选仓库', () => {
    expect(shouldResumeAtRepoStep({ connected: true, usable: 'usable' })).toBe(true);
    expect(revokedConnectionHint({ connected: true, usable: 'usable' })).toBeNull();
  });

  it('授权已被撤销 —— 留在第一步并说清原因', () => {
    // 这是 2026-09-15 对抗审查那条：只看 connected 会跳到第二步，然后撞 401
    expect(shouldResumeAtRepoStep({ connected: true, usable: 'revoked' })).toBe(false);
    expect(revokedConnectionHint({ connected: true, usable: 'revoked' })).toContain('重新授权');
  });

  it('问不出结论时放行 —— 不把网络抖动当成失效', () => {
    expect(shouldResumeAtRepoStep({ connected: true, usable: 'unknown' })).toBe(true);
    expect(shouldResumeAtRepoStep({ connected: true })).toBe(true);
    expect(shouldResumeAtRepoStep({ connected: true, usable: null })).toBe(true);
    expect(revokedConnectionHint({ connected: true, usable: 'unknown' })).toBeNull();
  });

  it('压根没连过 —— 当然停在第一步，但那不是「被撤销」', () => {
    expect(shouldResumeAtRepoStep({ connected: false, usable: null })).toBe(false);
    expect(revokedConnectionHint({ connected: false, usable: 'revoked' })).toBeNull();
  });
});

describe('「换个账号」时关于旧连接该说什么', () => {
  it('确认还能用 —— 说出是谁，并且可以断言它仍然有效', () => {
    expect(replacingConnectionNotice({ connected: true, usable: 'usable', login: 'someone' }, true))
      .toEqual({ login: 'someone', assertValid: true });
  });

  it('没问出结论 —— 可以说出是谁，但不许断言它仍然有效', () => {
    // 探测超时或非 401 的失败都会落到 unknown，那时有效性根本没被确认过
    expect(replacingConnectionNotice({ connected: true, usable: 'unknown', login: 'someone' }, true))
      .toEqual({ login: 'someone', assertValid: false });
    expect(replacingConnectionNotice({ connected: true, login: 'someone' }, true))
      .toEqual({ login: 'someone', assertValid: false });
  });

  it('授权已被撤销 —— 整句都不说', () => {
    expect(replacingConnectionNotice({ connected: true, usable: 'revoked', login: 'someone' }, true)).toBeNull();
  });

  it('没在换账号、或压根没连过 —— 不说', () => {
    expect(replacingConnectionNotice({ connected: true, usable: 'usable', login: 'someone' }, false)).toBeNull();
    expect(replacingConnectionNotice({ connected: false, usable: null, login: null }, true)).toBeNull();
    expect(replacingConnectionNotice(null, true)).toBeNull();
  });

  it('放行与断言是两把尺子：同一个 unknown，门禁放行、嘴上不许说', () => {
    const unknown = { connected: true, usable: 'unknown' as const, login: 'someone' };
    expect(shouldResumeAtRepoStep(unknown)).toBe(true);
    expect(replacingConnectionNotice(unknown, true)?.assertValid).toBe(false);
  });
});

describe('标题栏怎么称呼当前这条连接', () => {
  it('还能用 / 没问出结论 —— 说「已连接」', () => {
    expect(connectionHeaderLabel({ connected: true, usable: 'usable', login: 'someone' })).toBe('已连接 someone');
    expect(connectionHeaderLabel({ connected: true, usable: 'unknown', login: 'someone' })).toBe('已连接 someone');
  });

  it('已撤销 —— 不许说「已连接」，要说清这是条失效的本地记录', () => {
    // 同一屏上正显示着「授权已被撤销，请重新授权」，标题栏再说已连接就是当面打架
    const label = connectionHeaderLabel({ connected: true, usable: 'revoked', login: 'someone' });
    expect(label).not.toContain('已连接');
    expect(label).toContain('someone');
    expect(label).toContain('失效');
  });

  it('没连过 —— 整块不显示', () => {
    expect(connectionHeaderLabel({ connected: false, usable: null, login: null })).toBeNull();
    expect(connectionHeaderLabel(null)).toBeNull();
  });

  it('连着但拿不到登录名 —— 仍然给得出称呼，不渲染出空洞', () => {
    expect(connectionHeaderLabel({ connected: true, usable: 'usable', login: null })).toBe('已连接 GitHub 账号');
  });
});

describe('读完连接状态之后该待在哪一步', () => {
  const steps = { connect: 'connect' as const, repo: 'repo' as const };

  it('授权已失效 —— 不管此前在哪，一律回第一步', () => {
    // 这条尤其管「断开时被并发替换、重读发现新令牌也一起失效」那条路：
    // 人若停在选目录那一步，点什么都报错，而能解决问题的入口在第一步。
    for (const prev of ['connect', 'repo', 'directories'] as const) {
      expect(nextStepAfterAuthLoad(prev, { connected: true, usable: 'revoked' }, steps)).toBe('connect');
    }
  });

  it('连接没了 —— 同样一律回第一步', () => {
    for (const prev of ['connect', 'repo', 'directories'] as const) {
      expect(nextStepAfterAuthLoad(prev, { connected: false, usable: null }, steps)).toBe('connect');
    }
  });

  it('还在第一步且可用 —— 前进到选仓库', () => {
    expect(nextStepAfterAuthLoad('connect', { connected: true, usable: 'usable' }, steps)).toBe('repo');
    expect(nextStepAfterAuthLoad('connect', { connected: true, usable: 'unknown' }, steps)).toBe('repo');
  });

  it('已经在后面的步骤且连接好着 —— 保持原地，别把正在选目录的人弹走', () => {
    expect(nextStepAfterAuthLoad('directories', { connected: true, usable: 'usable' }, steps)).toBe('directories');
    expect(nextStepAfterAuthLoad('repo', { connected: true, usable: 'unknown' }, steps)).toBe('repo');
  });
});
