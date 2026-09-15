import { describe, expect, it } from 'vitest';
import {
  isGitHubConnectionBroken, connectionBrokenHint,
  shouldResumeAtRepoStep, revokedConnectionHint,
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
