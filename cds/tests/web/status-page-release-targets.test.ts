/**
 * 监控中心「三类来源不能混读」契约（源码守卫 + 纯函数真值）。
 *
 * cds/web 没有 jsdom / testing-library 设施（vitest 只跑纯 TS），沿用
 * tests/web/status-page-view-state.test.ts 同款做法：纯函数直接断言，
 * 渲染层对 .tsx 源码做契约扫描。
 *
 * 守的是同一件事：**生产目标不能被读成分支目标，自定义目标不能被读成系统推导的**。
 * 生产的可用率是线上承诺，分支的是临时环境噪声，自定义的是用户自己要盯的外部依赖；
 * 三者长得一样就等于状态页在说谎。2026-09-08 监控中心重做后分组依据从
 * `probeKind === 'url'` 改为后端下发的 `source` 字段——probeKind 只说「怎么探」，
 * source 才说「这是谁的承诺」（自定义 HTTP 监控的 probeKind 也是 url）。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBE_KIND_LABEL,
  SOURCE_META,
  SOURCE_ORDER,
  groupTargetsBySource,
  type UptimeTargetSummary,
} from '../../web/src/lib/monitorCenter.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel: string): string => fs.readFileSync(path.join(WEB, rel), 'utf8');

/**
 * 只扫代码，不扫注释。否则「禁止某种写法」的守卫会被解释该写法为什么危险的
 * 那段注释自己触发。顺序必须先行注释、后块注释（行注释里可能有 `/*`）。
 */
function stripComments(raw: string): string {
  return raw.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const statusPage = stripComments(read('pages/StatusPage.tsx'));
const targetList = stripComments(read('pages/status/TargetList.tsx'));
const targetDetail = stripComments(read('pages/status/TargetDetail.tsx'));
const primitives = stripComments(read('pages/status/primitives.tsx'));

function target(over: Partial<UptimeTargetSummary>): UptimeTargetSummary {
  return {
    id: 'x', source: 'branch', name: 'x', branchId: '', projectId: '', profileId: '', probeKind: 'http',
    status: 'up', lastSample: null, availability24h: 1, availability7d: 1, avgLatencyMs24h: 1, sampleCount24h: 1,
    buckets: [], openIncidentSince: null, statusSince: null, incidentCount: 0, probeDescription: '',
    intervalSeconds: 60, timeoutMs: 5000, ...over,
  };
}

describe('源码扫描前提', () => {
  it('剃注释没把真代码一起剃掉', () => {
    expect(statusPage).toContain('export function StatusPage');
    expect(targetList).toContain('export function TargetList');
    expect(targetDetail).toContain('export function TargetDetail');
    expect(statusPage.length).toBeGreaterThan(read('pages/StatusPage.tsx').length * 0.5);
  });
});

describe('探测方式文案覆盖全部五种 probeKind', () => {
  it('用 Record 映射给文案，不许退回二分三元', () => {
    // 事故值：`probeKind === 'http' ? A : B` 会把生产目标标成「按容器状态判定」——
    // 生产站点在 CDS 这边压根没有容器，这句话既是假的，又会让人以为这行不是真探出来的。
    expect(Object.keys(PROBE_KIND_LABEL).sort()).toEqual(['container', 'http', 'keyword', 'tcp', 'url']);
    expect(PROBE_KIND_LABEL.url).toContain('URL');
    expect(PROBE_KIND_LABEL.container).toContain('容器');
    for (const src of [statusPage, targetList, targetDetail, primitives]) {
      expect(src).not.toMatch(/probeKind === 'http'\s*\?/);
      expect(src).not.toMatch(/probeKind === 'url'\s*\?/);
    }
  });
});

describe('三类来源视觉可区分', () => {
  it('分组依据是 source 字段，顺序为 自定义 → 生产 → 分支，空组不出现', () => {
    expect(SOURCE_ORDER).toEqual(['custom', 'release', 'branch']);
    expect(SOURCE_META.release.label).toBe('生产发布目标');
    expect(SOURCE_META.branch.label).toBe('分支预览服务');
    expect(SOURCE_META.custom.label).toBe('自定义监控');
    const groups = groupTargetsBySource([
      target({ id: 'b1', source: 'branch', name: 'main / api' }),
      // 自定义 HTTP 监控的 probeKind 也是 url：按 probeKind 分组会把它误归到生产。
      target({ id: 'c1', source: 'custom', name: '上游网关', probeKind: 'url', status: 'down' }),
      target({ id: 'r1', source: 'release', name: '生产 / 官网', probeKind: 'url' }),
    ]);
    expect(groups.map((g) => g.source)).toEqual(['custom', 'release', 'branch']);
    expect(groups[0].targets.map((t) => t.id)).toEqual(['c1']);
    expect(groups[0].down).toBe(1);
    expect(groups[1].targets.map((t) => t.id)).toEqual(['r1']);
  });

  it('列表真的按 groupTargetsBySource 渲染，且没有绕开分组的第二条渲染路径', () => {
    expect(targetList).toContain('groupTargetsBySource(targets)');
    expect(targetList).toMatch(/groups\.map\(/);
    expect(targetList).not.toMatch(/targets\.map\(\(target\) => <TargetRow/);
    expect(statusPage).not.toMatch(/summary\.targets\.map\(/);
  });

  it('每行 / 详情头都挂来源标，徽标能看到探测地址', () => {
    expect(primitives).toContain('export function SourceBadge');
    expect(targetDetail).toContain('<SourceBadge source={target.source} full />');
    expect(targetDetail).toContain('title={target.probeDescription}');
    expect(targetDetail).toContain('{target.probeUrl}');
  });
});

describe('页面文案不能只讲分支', () => {
  it('空状态与来源说明都说清生产目标怎么进来、怎么被探', () => {
    // 事故值：文案只写「只探测正在运行的分支服务」「直连容器宿主端口」，
    // 用户会以为生产那几行是哪儿冒出来的，或者以为它也走的宿主端口。
    const emptyState = statusPage.slice(statusPage.indexOf('还没有可监控的目标'));
    expect(emptyState).toContain('healthcheckUrl');
    expect(emptyState).toContain('自定义监控');
    expect(SOURCE_META.release.hint).toContain('上线地址');
    expect(SOURCE_META.branch.hint).toContain('宿主端口');
    expect(statusPage).toContain('生产与自定义目标请求其地址');
  });
});
