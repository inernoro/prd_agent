/**
 * 状态页三态守卫（2026-07-27）。
 *
 * 旧实现只有 `summary` 一个信号：首次加载失败时只 setError，summary 仍是 null，
 * 于是页面同时渲染「读取失败」横幅和永久骨架屏——屏幕在说两件矛盾的事，
 * 读屏用户还会一直听到 role="status" 的「正在读取存活监控数据」。
 *
 * 本文件锁住两件事：
 *   1. 判定纯函数 resolveStatusViewPhase 把 loading / ready / error 分清楚；
 *   2. 源码守卫：StatusPage 只在 loading 相位渲染骨架，错误相位必须给
 *      原因 + 重试按钮（引导式空状态），不能回退成 `!summary ? 骨架` 的写法。
 *
 * cds/web 没有 jsdom / testing-library 设施（vitest 只跑 tests/**\/*.test.ts 的
 * 纯 TS），所以走本仓库既有的「纯函数单测 + 源码契约守卫」双保险，与
 * tests/web/bottom-right-overlay-offsets.test.ts 同款做法。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeStatusLoadError,
  resolveStatusViewPhase,
} from '../../web/src/lib/statusView.js';

const STATUS_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web/src/pages/StatusPage.tsx',
);

describe('resolveStatusViewPhase 三态判定', () => {
  it('首次加载中（无数据无错误）= loading', () => {
    expect(resolveStatusViewPhase({ hasSummary: false, error: null })).toBe('loading');
  });

  it('首次加载失败（无数据有错误）= error，不再算加载中', () => {
    expect(resolveStatusViewPhase({ hasSummary: false, error: '网络异常' })).toBe('error');
  });

  it('已有数据 = ready；即便后续轮询失败也保留旧数据 + 顶部提示', () => {
    expect(resolveStatusViewPhase({ hasSummary: true, error: null })).toBe('ready');
    expect(resolveStatusViewPhase({ hasSummary: true, error: '网络异常' })).toBe('ready');
  });
});

describe('describeStatusLoadError 给出可行动的原因', () => {
  it('登录态失效 → 提示重新登录', () => {
    const view = describeStatusLoadError('401 未授权');
    expect(view.title).toContain('登录');
    expect(view.hint.length).toBeGreaterThan(0);
  });

  it('端点缺失 → 提示 CDS 版本不含存活监控', () => {
    expect(describeStatusLoadError('404 Not Found').title).toContain('存活监控');
  });

  it('连不上 → 提示检查 CDS 服务是否在跑', () => {
    expect(describeStatusLoadError('Failed to fetch').title).toContain('连接');
  });

  it('未知错误也必须带原文，绝不吞掉', () => {
    const view = describeStatusLoadError('boom');
    expect(view.hint).toContain('boom');
  });
});

describe('StatusPage 源码契约', () => {
  const source = fs.readFileSync(STATUS_PAGE, 'utf-8');

  it('骨架屏只在 loading 相位渲染，不再用 `!summary` 当加载判据', () => {
    expect(source).toContain('resolveStatusViewPhase');
    expect(source).toContain("phase === 'loading'");
    expect(source).not.toContain('{!summary ? (');
  });

  it('错误相位有重试按钮与错误说明，不是一句「加载失败」了事', () => {
    expect(source).toContain("phase === 'error'");
    expect(source).toContain('describeStatusLoadError');
    expect(source).toContain('重新加载');
  });
});
