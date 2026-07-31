/**
 * release-center-review-fixes.test.ts —— Codex 第二、三轮 review 的判定源。
 *
 * 每一段对应一条：预览地址不许凭空造、主目标默认值、试跑失败要说清楚、
 * 外发链接必须绝对化。都是纯函数，配一条接线守卫证明页面真的在用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolvePreviewUrl } from '../../web/src/lib/previewUrl';
import { canonicalEnvironments, defaultIsCanonical } from '../../web/src/lib/releaseEnvironments';
import { describeDryRunResult } from '../../web/src/lib/releaseDiagnosis';
import { absoluteNoticeActionUrl, normalizeNoticeOrigin } from '../../src/services/notice-outbound-map.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '../../web/src', rel), 'utf8');

const BRANCH = { id: 'br_1', previewSlug: 'feature-x' };
const CONFIG = { previewDomain: 'miduo.org', rootDomains: ['miduo.org'], workerPort: 5500, mainDomain: 'app.miduo.org' };
const ORIGIN = { protocol: 'https:', hostname: 'cds.miduo.org' };

describe('resolvePreviewUrl 不为 port 模式编造地址', () => {
  it('port 模式返回空串，交给发布前检查拦下', () => {
    expect(resolvePreviewUrl('port', BRANCH, CONFIG, ORIGIN)).toBe('');
  });

  it('multi 模式仍按子域公式推导', () => {
    // 线上域名不补端口（hostWithPort 只给本机域名补），所以这里没有 :5500。
    expect(resolvePreviewUrl('multi', BRANCH, CONFIG, ORIGIN)).toBe('https://feature-x.miduo.org');
  });

  it('simple 模式走主域名', () => {
    expect(resolvePreviewUrl('simple', BRANCH, CONFIG, ORIGIN)).toBe('https://app.miduo.org');
  });

  it('port 模式绝不返回 multi 那条子域', () => {
    // 这才是问题的要害：那个地址语法合法、非空、能通过「产物非空」检查，
    // 然后作为 CDS_PREVIEW_URL 一路传进发布脚本——而它没有任何东西在监听。
    const multi = resolvePreviewUrl('multi', BRANCH, CONFIG, ORIGIN);
    expect(resolvePreviewUrl('port', BRANCH, CONFIG, ORIGIN)).not.toBe(multi);
  });
});

describe('StartReleaseDialog 为 port 模式现取端口（接线守卫）', () => {
  const source = read('pages/release-center/StartReleaseDialog.tsx');

  it('调用 preview-port 端点而不是把空串直接交出去', () => {
    expect(source).toContain('/preview-port');
    expect(source).toMatch(/previewMode !== 'port'/);
  });
});

describe('主目标默认值随环境而定', () => {
  const sections = [
    { environment: 'production', label: '生产', entries: [], disabledEntries: [], canonicalTargetId: 'rt_prod' },
    { environment: 'staging', label: '预发', entries: [], disabledEntries: [] },
  ];

  it('已有主目标的环境被收进集合', () => {
    expect(canonicalEnvironments(sections)).toEqual(new Set(['production']));
  });

  it('退化分组（后端没下发 environments）不参与判定', () => {
    const degraded = [{ environment: 'production', label: '发布目标', entries: [], disabledEntries: [], canonicalTargetId: 'rt_x', degraded: true }];
    expect(canonicalEnvironments(degraded).size).toBe(0);
  });

  it('该环境已有主目标 → 默认不勾（否则保存必被后端拒）', () => {
    expect(defaultIsCanonical('production', canonicalEnvironments(sections))).toBe(false);
  });

  it('该环境还没有主目标 → 默认勾上（省掉一次必然的勾选）', () => {
    expect(defaultIsCanonical('staging', canonicalEnvironments(sections))).toBe(true);
    expect(defaultIsCanonical('other', canonicalEnvironments(sections))).toBe(true);
  });

  it('第一个目标（空集合）默认就是主目标', () => {
    expect(defaultIsCanonical('production', new Set())).toBe(true);
  });
});

describe('试跑结论说清楚哪一项没过', () => {
  it('失败时给 error，而不是那条恒定的安全横幅', () => {
    const result = {
      ok: false,
      error: '发布前检查未通过：可发布产物',
      log: '本次只做检查、未发布\n  [fail] 可发布产物：缺少预览地址或 commit',
    };
    const text = describeDryRunResult(result);
    expect(text).toContain('可发布产物');
    expect(text).not.toBe('本次只做检查、未发布');
  });

  it('没有 error 时退到日志里的 fail 行', () => {
    const text = describeDryRunResult({
      ok: false,
      log: '本次只做检查、未发布\n  [fail] 发布目标：生产站点 已禁用',
    });
    expect(text).toContain('生产站点 已禁用');
  });

  it('两种都没有才用兜底文案', () => {
    expect(describeDryRunResult({ ok: false })).toBe('试跑未通过：发布前检查存在阻塞项');
  });

  it('成功与失败的文案必须能区分开', () => {
    const ok = describeDryRunResult({ ok: true, log: '本次只做检查、未发布' });
    const bad = describeDryRunResult({ ok: false, error: 'x', log: '本次只做检查、未发布' });
    expect(ok).not.toBe(bad);
    expect(ok).toContain('通过');
  });
});

describe('外发到 MAP 的链接必须是 CDS 自己的绝对地址', () => {
  it('裸域名补 https', () => {
    expect(normalizeNoticeOrigin('cds.miduo.org')).toBe('https://cds.miduo.org');
    expect(normalizeNoticeOrigin('https://cds.miduo.org/')).toBe('https://cds.miduo.org');
    expect(normalizeNoticeOrigin('')).toBe('');
    expect(normalizeNoticeOrigin(undefined)).toBe('');
  });

  it('相对路径拼成 CDS 的绝对地址', () => {
    expect(absoluteNoticeActionUrl('/release-center?target=t', 'cds.miduo.org'))
      .toBe('https://cds.miduo.org/release-center?target=t');
  });

  it('没有配 origin 就不给动作——宁可没有按钮，也不给一个必然点错的', () => {
    // 原样发相对路径的话，MAP 会按**自己**的 origin 展开，点开落到 MAP 的
    // /release-center，一个不存在的页面。
    expect(absoluteNoticeActionUrl('/release-center', undefined)).toBe('');
    expect(absoluteNoticeActionUrl('/release-center', '')).toBe('');
  });

  it('非相对路径一律不外发', () => {
    expect(absoluteNoticeActionUrl('https://evil.example/x', 'cds.miduo.org')).toBe('');
    expect(absoluteNoticeActionUrl('', 'cds.miduo.org')).toBe('');
  });
});
