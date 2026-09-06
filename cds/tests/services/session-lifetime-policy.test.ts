import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 登录有效期是「一份策略管所有登录路径」：GitHub/本地密码会话、ticket SSO 会话、
 * basic 模式的 cds_token 都必须读同一个 sessionTtlMs，且都能滑动续期。
 *
 * 这些路径散在 server.ts 的不同分支里，单测很难同时拉起，所以用源码级守卫钉住
 * 「没有人再往回写死一个时长」——历史上 SSO 写死 12 小时、basic 写死 30 天，
 * 都是在「已经统一了」的说法下悄悄漏掉的。
 */
const serverSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'),
  'utf8',
);

describe('session lifetime policy (single source)', () => {
  it('computes the TTL policy once and feeds every login path from it', () => {
    expect(serverSource).toContain('const sessionTtlMs = sessionTtlDays * 24 * 60 * 60 * 1000');
    // ticket SSO 会话
    expect(serverSource).toContain('new TicketSsoSessionStore(sessionTtlMs)');
    // GitHub / 本地密码会话
    expect(serverSource).toContain('config: { allowedOrgs, sessionTtlMs }');
    // basic 模式 cds_token
    expect(serverSource).toContain('basicSessionCookie(humanSessionToken, sessionTtlMs, cookieSecure)');
  });

  it('never hardcodes a login window next to the cookie writers', () => {
    // 曾经的两处硬编码：basic 的 30 天、SSO 的 12 小时。
    expect(serverSource).not.toContain('Max-Age=${30 * 86400}');
    expect(serverSource).not.toContain('12 * 60 * 60 * 1000');
  });

  it('re-issues the basic-mode cookie on authenticated use so it slides', () => {
    // basic 模式没有服务端会话记录，只能靠重发 cookie 续期；漏了就退回固定期限。
    const gateIndex = serverSource.indexOf('if (humanCookieValid || machineHeaderValid) {');
    expect(gateIndex).toBeGreaterThan(0);
    const gateBlock = serverSource.slice(gateIndex, gateIndex + 800);
    expect(gateBlock).toContain('basicSessionCookie(renewedToken, sessionTtlMs, cookieSecure)');
    // 只对 cookie 认证续期：x-cds-token 走机器凭据，不涉及浏览器 cookie。
    expect(gateBlock).toContain('if (humanCookieValid)');
  });
});
