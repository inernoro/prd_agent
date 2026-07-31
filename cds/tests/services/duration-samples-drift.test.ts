import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「防再修一边」守卫：耗时台账与 ETA 的判定各自只有一个源。
 *
 * 事故值：系统里现在有两份耗时台账（分支部署 deployDurationSamples、生产发布
 * releaseDurationSamples）。第二份落地时最省事的写法是把 state.ts 里那段
 * 「排序 → 取中位 → ring buffer 截断」照抄一遍——抄完之后调窗口/调上限只会改到
 * 一边，两份台账的口径从此各说各话。本 PR 前七轮 review 反复栽在这类「同一判定
 * 改了一边忘了另一边」上，所以判定只留一处，靠源码扫描钉住。
 *
 * 前端同理：发布 ETA 的「median − elapsed」与无样本文案只允许住在
 * web/src/lib/releaseEta.ts，页面里不许再长一份。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relative), 'utf8');
}

/**
 * 发布中心 v2 已从单文件拆成 pages/release-center/ 下的一组组件，
 * 所以这里扫「入口页 + 整个目录」——只盯入口页的话，任何一份 ETA 拷贝
 * 搬进子组件都会让本套件静默变绿。
 */
function releaseCenterSurface(): string {
  const dir = path.join(CDS_ROOT, 'web/src/pages/release-center');
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => path.join(dir, name));
  return [path.join(CDS_ROOT, 'web/src/pages/ReleaseCenterPage.tsx'), ...files]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

function walk(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const stack = [path.join(CDS_ROOT, relativeDir)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path.relative(CDS_ROOT, full));
    }
  }
  return out;
}

/** 排序取中位的两种写法特征：偶数分支的 sorted[mid - 1]，或奇偶判定 length % 2。 */
const P50_SHAPE = /sorted\[mid - 1\]|sorted\.length % 2/;

/** 只看真正会渲染出去的字符串字面量——注释里提到某个文案不算页面自己在拼它。 */
function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) literals.push(match[2]);
  return literals;
}

describe('耗时样本判定只有一个源', () => {
  it('p50 中位算式在后端只出现在 duration-samples.ts', () => {
    const hits = walk('src', ['.ts']).filter((file) => P50_SHAPE.test(read(file)));
    expect(hits).toEqual(['src/services/duration-samples.ts']);
  });

  it('追加/估算函数也只在 duration-samples.ts 定义', () => {
    const hits = walk('src', ['.ts'])
      .filter((file) => /export function (?:appendDurationSample|computeDurationEstimate)\b/.test(read(file)));
    expect([...new Set(hits)]).toEqual(['src/services/duration-samples.ts']);
  });

  it('state.ts 两份台账都走同一对纯函数，自己不再算', () => {
    const source = read('src/services/state.ts');

    expect(source).toContain("from './duration-samples.js'");
    // 分支部署与生产发布各自的读写口径都委派出去。
    expect((source.match(/appendDurationSample\(/g) || []).length).toBe(2);
    expect((source.match(/computeDurationEstimate\(/g) || []).length).toBe(2);
    // 本文件不许再出现裸的中位算式或裸的 ring buffer 截断。
    expect(source).not.toMatch(P50_SHAPE);
    expect(source).not.toMatch(/while \([a-zA-Z]+\.length > StateService\.DEPLOY_DURATION_SAMPLES_MAX\)/);
  });

  it('两份台账是两个顶层字段，没有共用同一个 buckets 对象', () => {
    const types = read('src/types.ts');
    expect(types).toContain('deployDurationSamples?: DeployDurationSamples;');
    expect(types).toContain('releaseDurationSamples?: DeployDurationSamples;');

    const state = read('src/services/state.ts');
    // 事故值：生产发布耗时曾计划复用 deployDurationSamples 的 mode='release' 桶，
    // 而那个 release 指分支容器跑极速版镜像（中位 42s）——与 SSH 发布（8 分钟量级）
    // 语义无关，合桶后两边中位互相拉扯。getReleaseEstimate 必须读自己的字段。
    expect(state).toMatch(/getReleaseEstimate\([\s\S]*?releaseDurationSamples/);
    expect(state).not.toMatch(/getReleaseEstimate[\s\S]{0,400}?deployDurationSamples/);
  });
});

describe('发布 ETA 判定只有一个源', () => {
  it('ETA 计算与文案只在 web/src/lib/releaseEta.ts 定义', () => {
    const hits = walk('web/src', ['.ts', '.tsx'])
      .filter((file) => /export function (?:computeReleaseEta|releaseEtaText|formatEtaClock)\b/.test(read(file)));
    expect([...new Set(hits)]).toEqual(['web/src/lib/releaseEta.ts']);
  });

  it('发布中心页面只消费，不自己算 median 与 elapsed 的差', () => {
    const source = releaseCenterSurface();

    expect(source).toContain("from '@/lib/releaseEta'");
    expect(source).toContain('releaseEtaText(');
    expect(source).not.toMatch(/medianMs\s*-\s*elapsed/);
    expect(source).not.toMatch(/function (?:computeReleaseEta|releaseEtaText|formatEtaClock)\b/);
  });

  it('发布进行中的计时每秒走动，样本不足时也不许静止', () => {
    const source = releaseCenterSurface();

    // 事故值：只在 SSE 状态事件里重渲染。相邻两次状态事件之间可能几分钟没有一条，
    // 秒数定住 = 用户眼里的「页面卡死」；历史样本不足时更是只剩这个计时能证明
    // 系统还活着，静止的「加载中」就是缺陷。
    //
    // v2 起秒表不再在本页复制一份：走全局共享的 @/hooks/useNowTick
    // （BranchListPage 用的也是它）。判据随之变成「引用共享源 + 该开表的地方都开了」。
    expect(source).toContain("from '@/hooks/useNowTick'");
    expect(read('web/src/hooks/useNowTick.ts'))
      .toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), intervalMs\)/);
    expect(source).not.toMatch(/function useNowTick\(/);
    // 概览的「正在发布」、日志弹窗、就地发布抽屉三处都要开表，少一处那一处就是静止的。
    expect((source.match(/useNowTick\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('无样本文案是唯一的诚实兜底，页面里不许写死一个预计数字', () => {
    const lib = read('web/src/lib/releaseEta.ts');
    expect(lib).toContain('正在积累历史耗时数据，暂无预计');
    // 无样本一律 null，不回落到 0（回落即渲染「预计还需 00:00」）。
    expect(lib).toMatch(/remainingMs: null/);

    const pageLiterals = stringLiterals(releaseCenterSurface()).join('\n');
    expect(pageLiterals).not.toContain('预计还需');
    expect(pageLiterals).not.toContain('正在积累历史耗时数据');
  });
});
