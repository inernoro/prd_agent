/**
 * notice-href-safety.test.ts — 站内信 href 白名单。
 *
 * 攻击面（Codex review P1，2026-07-29）：通知可以由**项目级** Agent Key 通过
 * POST /api/notices 写入，而 SiteNoticeInbox 把 href 直接渲染成 `<a href={...}>`。
 * 一条 `javascript:...` 就成了存储型脚本执行——由**全局运维**在自己的 CDS 会话里
 * 点开触发，等于低权限凭据借高权限的手执行。
 *
 * 判据放在账本层而不是路由层，是因为账本是所有写入路径的必经之地（内部事件
 * 渲染也走 upsert），挡在这儿才没有绕过口。
 */

import { describe, expect, it } from 'vitest';

import { sanitizeNoticeHref } from '../../src/services/notice-ledger.js';

describe('sanitizeNoticeHref', () => {
  it('放行内部产出的同源相对路径', () => {
    expect(sanitizeNoticeHref('/release-center?project=p&target=t&run=r'))
      .toBe('/release-center?project=p&target=t&run=r');
    expect(sanitizeNoticeHref('/status')).toBe('/status');
    expect(sanitizeNoticeHref('/cds-settings#remote-hosts')).toBe('/cds-settings#remote-hosts');
  });

  it('挡掉可执行 scheme', () => {
    for (const evil of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      expect(sanitizeNoticeHref(evil), evil).toBeUndefined();
    }
  });

  it('挡掉用控制字符拼回来的 scheme', () => {
    // 浏览器解析 URL 时会忽略内嵌的换行/制表符，`java\nscript:` 照样执行。
    expect(sanitizeNoticeHref('java\nscript:alert(1)')).toBeUndefined();
    expect(sanitizeNoticeHref('java\tscript:alert(1)')).toBeUndefined();
    expect(sanitizeNoticeHref('/ok\u0000/path')).toBeUndefined();
  });

  it('挡掉协议相对 URL（开放重定向）', () => {
    expect(sanitizeNoticeHref('//evil.example/x')).toBeUndefined();
    expect(sanitizeNoticeHref('///evil.example/x')).toBeUndefined();
  });

  it('挡掉绝对外链：通知不是决定跳站外的地方', () => {
    expect(sanitizeNoticeHref('https://evil.example/x')).toBeUndefined();
    expect(sanitizeNoticeHref('http://evil.example/x')).toBeUndefined();
  });

  it('挡掉相对路径（会随当前页解析，指向不确定）', () => {
    expect(sanitizeNoticeHref('release-center')).toBeUndefined();
    expect(sanitizeNoticeHref('../admin')).toBeUndefined();
  });

  it('空值与非字符串一律当没给', () => {
    expect(sanitizeNoticeHref('')).toBeUndefined();
    expect(sanitizeNoticeHref('   ')).toBeUndefined();
    expect(sanitizeNoticeHref(undefined)).toBeUndefined();
    expect(sanitizeNoticeHref(null)).toBeUndefined();
    expect(sanitizeNoticeHref(42)).toBeUndefined();
    expect(sanitizeNoticeHref({ toString: () => '/evil' })).toBeUndefined();
  });
});

describe('账本落库时必须过白名单（接线守卫）', () => {
  it('upsert 走 sanitizeNoticeHref，而不是原样存 incoming.href', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.resolve(here, '../../src/services/notice-ledger.ts'), 'utf8');
    // 摘掉这一步的话，路由层校验一旦被绕过（或将来新增写入路径）就没有第二道闸。
    expect(source).toMatch(/sanitizeNoticeHref\(incoming\.href\)/);
    expect(source).not.toMatch(/\{ href: incoming\.href \}/);
  });
});
