/**
 * 「更新请求还没进到应用就被挡回」的中文归因守卫。
 *
 * 2026-07-30 实测：生产 cds.miduo.org 的 POST /api/self-update 在边缘层被拦，
 * 无鉴权即返回 503 + 纯文本 `self-update temporarily disabled by operations`，
 * 且响应里没有 x-powered-by / x-cds-request-id（对比同域的 401 有）——
 * 说明它根本没进 Express。后端的失败归因覆盖不到这一层，只能在前端翻译。
 *
 * 这条正是用户投诉「普通更新总是有问题报错，还是英文错」里最刺眼的一条：
 * 每次必现、全英文、而且因为没进应用，更新历史里查不到任何记录。
 */

import { describe, it, expect } from 'vitest';
import {
  diagnoseSelfUpdateHttpFailure,
  formatSelfUpdateHttpFailure,
} from '../../web/src/lib/selfUpdateHttpFailure.js';

const isChinese = (text: string): boolean => /[一-龥]/.test(text);

/** 2026-07-30 从生产环境抓到的真实响应。 */
const PRODUCTION_BODY = 'self-update temporarily disabled by operations';

describe('更新请求被边缘层挡回时的归因', () => {
  it('生产实测的 503 被翻成中文，且说明「没进到应用所以历史查不到」', () => {
    const f = diagnoseSelfUpdateHttpFailure(503, PRODUCTION_BODY, 3600);
    expect(isChinese(f.cause)).toBe(true);
    expect(f.cause).toContain('运维');
    // 用户困惑的核心：为什么更新历史里查不到这次失败。必须主动解释。
    expect(f.cause).toContain('历史');
    // 英文原文只能待在 raw 里。
    expect(f.cause).not.toContain('temporarily disabled');
    expect(f.nextAction).not.toContain('temporarily disabled');
    expect(f.raw).toBe(PRODUCTION_BODY);
  });

  it('Retry-After 换算成分钟写进文案，用户知道等多久', () => {
    const f = diagnoseSelfUpdateHttpFailure(503, PRODUCTION_BODY, 3600);
    expect(f.cause).toContain('60 分钟');
    const noRetry = diagnoseSelfUpdateHttpFailure(503, PRODUCTION_BODY);
    expect(noRetry.cause).not.toContain('分钟');
  });

  it('明确指出这不是 CDS 故障，并指向解除拦截规则', () => {
    const f = diagnoseSelfUpdateHttpFailure(503, PRODUCTION_BODY, 3600);
    expect(f.nextAction).toContain('不是 CDS 故障');
    expect(f.nextAction).toContain('/api/self-update');
  });

  it('各状态码给出互不相同的中文原因', () => {
    const causes = [503, 401, 429, 502, 418].map(
      (status) => diagnoseSelfUpdateHttpFailure(status, '').cause,
    );
    expect(new Set(causes).size).toBe(causes.length);
    for (const cause of causes) expect(isChinese(cause)).toBe(true);
  });

  it('JSON 响应体也能取出原文，空响应体不炸', () => {
    const json = diagnoseSelfUpdateHttpFailure(503, JSON.stringify({ message: 'maintenance window' }));
    expect(json.raw).toBe('maintenance window');
    const empty = diagnoseSelfUpdateHttpFailure(500, '');
    expect(isChinese(empty.cause)).toBe(true);
    expect(empty.raw).toBe('');
  });

  it('弹窗文案两段齐全且不含英文原文', () => {
    const text = formatSelfUpdateHttpFailure(diagnoseSelfUpdateHttpFailure(503, PRODUCTION_BODY, 3600));
    expect(text).toContain('更新失败：');
    expect(text).toContain('下一步：');
    expect(text).not.toContain('temporarily disabled');
  });
});
