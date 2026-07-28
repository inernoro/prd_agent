/**
 * 状态页「生产发布目标」呈现契约（源码守卫）。
 *
 * cds/web 没有 jsdom / testing-library 设施（vitest 只跑纯 TS），沿用
 * tests/web/status-page-view-state.test.ts 同款做法：对 .tsx 源码做契约扫描。
 *
 * 守的是同一件事：**生产目标不能被读成分支目标**。它的可用率是线上承诺，
 * 分支目标的可用率是临时环境噪声，两者长得一样就等于状态页在说谎。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web/src/pages/StatusPage.tsx',
);

const raw = fs.readFileSync(STATUS_PAGE, 'utf8');

/**
 * 只扫代码，不扫注释。否则「禁止某种写法」的守卫会被解释该写法为什么危险的
 * 那段注释自己触发——本文件第一版就栽在这里。行注释只剃「整行都是注释」的那种，
 * 免得把字符串里的 `//`（如 URL）剃坏。
 *
 * 顺序必须先行注释、后块注释：StatusPage 有一条行注释里写着 `/api/uptime/*`，
 * 先剃块注释会把那个 `/*` 当成开头，一路吃到几十行之后的那个块注释结束符，把中间的真代码一起吞掉（守卫于是对着空字符串断言，全部假绿）。
 */
const source = raw
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('源码扫描前提', () => {
  it('剃注释没把真代码一起剃掉', () => {
    // 事故值：剃过头之后 source 变成空壳，下面所有 not.toMatch 全部恒真，
    // 一整个文件的守卫静默失效还显示绿色。
    expect(source).toContain('export function StatusPage');
    expect(source).toContain('function TargetRow');
    expect(source.length).toBeGreaterThan(raw.length * 0.5);
  });
});

describe('探测方式文案覆盖 url 型', () => {
  it('probeKind 类型带上 url，不再是二值联合', () => {
    // 事故值：类型没跟上 → 后端发来的 'url' 被 TS 当成不可能分支，
    // 前端任何按 probeKind 分流的逻辑都会走进错误的那一支。
    expect(source).toMatch(/type ProbeKind = 'http' \| 'container' \| 'url'/);
  });

  it('用三值映射给文案，不许退回二分三元', () => {
    // 事故值：`probeKind === 'http' ? 'HTTP 探测' : '按容器状态判定'` 会把生产目标
    // 标成「按容器状态判定」——而生产站点在 CDS 这边压根没有容器，这句话既是假的，
    // 又会让人以为这行不是真探出来的。
    expect(source).toContain('PROBE_KIND_LABEL');
    expect(source).toMatch(/PROBE_KIND_LABEL: Record<ProbeKind, string>/);
    expect(source).toMatch(/url: 'URL 探测（生产）'/);
    expect(source).not.toMatch(/probeKind === 'http'\s*\?/);
  });
});

describe('生产目标与分支目标视觉可区分', () => {
  it('分组渲染：生产发布目标单独成节', () => {
    expect(source).toContain('生产发布目标');
    expect(source).toContain('分支预览服务');
    expect(source).toMatch(/productionTargets/);
    expect(source).toMatch(/branchTargets/);
    // 分组依据必须是 probeKind，不是名字前缀这种能被用户随手改掉的东西。
    expect(source).toMatch(/filter\(\(target\) => target\.probeKind === 'url'\)/);
    // 真的接上了：有生产目标就走分组分支。只有标识符在场不算数——
    // 事故值：把闸门条件改死（如恒 false），生产目标又混回分支列表，而所有
    // 「提到 productionTargets」的弱断言仍然全绿。
    expect(source).toMatch(/productionTargets\.length > 0 \?/);
    expect(source).toMatch(/targets=\{productionTargets\}/);
    // 没有绕开分组的第二条渲染路径（旧写法是直接 summary.targets.map）。
    expect(source).not.toMatch(/summary\.targets\.map\(/);
  });

  it('生产目标行有额外强调，且徽标能看到探测地址', () => {
    expect(source).toMatch(/border-l-\[3px\]/);
    expect(source).toMatch(/title=\{target\.probeUrl\}/);
  });
});

describe('页面文案不能只讲分支', () => {
  it('空状态与页脚都说清生产目标怎么进来、怎么被探', () => {
    // 事故值：文案只写「只探测正在运行的分支服务」「直连容器宿主端口」，
    // 用户会以为生产那几行是哪儿冒出来的，或者以为它也走的宿主端口。
    const emptyState = source.slice(source.indexOf('还没有可监控的服务'));
    expect(emptyState).toContain('healthcheckUrl');
    const footer = source.slice(source.indexOf('数据由 CDS 自建探测器采集'));
    expect(footer).toContain('生产发布目标请求其上线地址');
  });
});
