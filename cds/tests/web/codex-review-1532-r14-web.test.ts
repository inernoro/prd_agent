/**
 * Codex 第十四轮（PR #1532，reviewed commit f8781138a9）里判为 A 类的四条。
 *
 * 共同形状：同一屏上两处说法互相矛盾，或者一句话里的措辞与它挂的那个数不是一回事。
 * 这类改坏了照样编译、照样渲染、通读也挑不出，只有真人盯着看才发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { projectTip } from '@/pages/reports/PipelinePanel';
import { splitFunnel } from '@/lib/pipelineFunnel';
import type { PipelineProjectRow } from '@/lib/api';

const SRC = path.resolve(process.cwd(), '../cds/web/src');
const STRIP = fs.readFileSync(path.join(SRC, 'pages/reports/CompactStrip.tsx'), 'utf8');
const TREND = fs.readFileSync(path.join(SRC, 'pages/reports/TrendCharts.tsx'), 'utf8');
const HEADLINE = fs.readFileSync(path.join(SRC, 'lib/pipelineHeadline.ts'), 'utf8');

function row(extra: Partial<PipelineProjectRow['funnel']> = {}): PipelineProjectRow {
  return {
    projectId: 'p', projectName: '某项目',
    funnel: { changes: 0, deployed: 0, accepted: 0, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0, ...extra },
    leaks: { 'merged-not-accepted': 0, 'merged-while-failing': 0, 'deployed-not-accepted': 0, 'report-missing-change-key': 0 },
    missingKinds: [], staleReports: 0, inFlight: 0, lastActivityAt: null, githubLinked: true,
  };
}

describe('悬浮提示不自相矛盾', () => {
  it('验过但一份结论都没填时，不说「一条都没验过」', () => {
    const tip = projectTip(row({ changes: 5, deployed: 5, accepted: 5 }));
    // 前置条件：夹具确实落在「验过 5 · 零结论」这一格。
    expect(tip).toContain('验过 5');
    expect(tip).not.toContain('一条都没验过');
    expect(tip).toContain('都没有填结论');
  });

  it('真的一条都没验过时照旧那么说', () => {
    const tip = projectTip(row({ changes: 5, deployed: 5, accepted: 0 }));
    expect(tip).toContain('一条都没验过');
  });

  it('有结论时给三档明细', () => {
    const tip = projectTip(row({ changes: 3, deployed: 3, accepted: 3, pass: 2, fail: 1 }));
    expect(tip).toContain('通过 2');
    expect(tip).not.toContain('都没有填结论');
  });
});

describe('三处分流读同一份数字', () => {
  it('挂在从未部署过的分支上的报告，累加值与逐级夹取值确实不同（判据有意义）', () => {
    const f = row({ changes: 4, deployed: 1, accepted: 3 }).funnel;
    expect(f.accepted).toBe(3);
    expect(splitFunnel(f).accepted).toBe(1);
  });

  it('紧凑态项目垛走 splitFunnel，而不是只夹到 changes', () => {
    expect(STRIP, '项目垛各算各的，同一屏两个数会打架')
      .toContain('splitFunnel(p.funnel).accepted');
    expect(STRIP).not.toMatch(/Math\.min\(ch, p\.funnel\.accepted\)/);
  });
});

describe('四条项目线彼此可区分', () => {
  it('四个档位的线型类名两两不同', () => {
    const cls = TREND.match(/const GREY_CLS = \[([^\]]+)\]/)?.[1] ?? '';
    const dash = TREND.match(/const GREY_DASH = \[([^\]]+)\]/)?.[1] ?? '';
    const parse = (s: string) => s.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    const c = parse(cls); const d = parse(dash);
    expect(c.length, '档位表没解析到').toBe(4);
    expect(new Set(c).size, '两条项目线共用同一个线型，图上与图例都分不出谁是谁').toBe(4);
    expect(new Set(d).size, '两个图例色块长得一样').toBe(4);
  });

  it('每个档位都有对应的样式定义', () => {
    for (const k of ['g1', 'g2', 'g3', 'g4']) {
      expect(TREND, `缺 .${k} 的描边定义，线会退回默认色`).toMatch(new RegExp(`\\.tc \\.${k}\\{stroke:`));
      expect(TREND, `缺 .d-${k} 的图例定义`).toMatch(new RegExp(`\\.tc \\.d-${k}\\{border-color:`));
    }
  });
});

describe('头条措辞与它挂的数是同一件事', () => {
  // 只扫会被渲染出来的那部分：注释里为了解释这条规则本身，必然要写出反例措辞。
  const code = HEADLINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  it('不把「窗口内开出来的改动」说成「在改的分支」', () => {
    expect(code, '已合并、已撤下的改动也在 changes 里，叫「在改的」是把完工的算成在办的')
      .not.toContain('在改的分支');
    // 前置条件：确认剥注释之后句子还在，不是把整个文件都剥没了导致空转。
    expect(code).toContain('条改动里');
  });
});
