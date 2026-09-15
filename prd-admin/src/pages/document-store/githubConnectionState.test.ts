import { describe, expect, it } from 'vitest';
import { isGitHubConnectionBroken, connectionBrokenHint } from './githubConnectionState';

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
