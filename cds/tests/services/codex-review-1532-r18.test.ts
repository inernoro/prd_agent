/**
 * Codex 第十八轮（PR #1532，reviewed commit f32c1c8c6f）里判为 A 类的两条后端项。
 *
 * 两条同形：判据只覆盖了「正常输入」那一段，落在段外的值静默走到另一个结论上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AcceptanceReportMeta, BranchEntry } from '../../src/types.js';
import { buildReportsOverview } from '../../src/services/acceptance-overview.js';

let seq = 0;
function report(partial: Partial<AcceptanceReportMeta> & { title: string; createdAt: string }): AcceptanceReportMeta {
  seq += 1;
  return { id: partial.id ?? `n${seq}`, format: 'md', sizeBytes: 1, projectId: 'proj', updatedAt: partial.createdAt, ...partial };
}
const TO = new Date('2026-09-07T00:00:00Z');

describe('负数缺陷计数不能把未通过的报告漂成可以正常使用', () => {
  it('p0 为负时按零算，仍然判进「这次没测出来」而不是 ok', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 甲 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'fail', defectCounts: { p0: -1 } }),
    ], [], { to: TO, days: 7 });
    // 前置条件：这份报告确实是 fail，否则下面断言的是别的东西。
    expect(o.totals.fail).toBe(1);
    expect(o.headline.statusLabel).not.toBe('可以正常使用');
    expect(o.headline.status).toBe('untested');
  });

  it('真有阻断缺陷时照旧判「有功能坏了」', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 乙 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'fail', defectCounts: { p0: 2 } }),
    ], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('broken');
  });

  it('负数不会把真实的阻断数抵消掉', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 丙 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'fail', defectCounts: { p0: 2, p1: -5 } }),
    ], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('broken');
  });
});

describe('最近动静要认推送', () => {
  it('只推过没重新部署的分支，活动时间跟着推送走', async () => {
    const { buildPipelineOverview } = await import('../../src/services/acceptance-pipeline.js');
    const branch = (b: Partial<BranchEntry>): BranchEntry => ({
      id: 'b1', branch: 'feat/x', projectId: 'proj', status: 'running',
      createdAt: '2026-09-01T00:00:00Z', ...b,
    } as BranchEntry);
    const out = buildPipelineOverview(
      [{ id: 'proj', name: '某项目' } as never],
      [branch({ lastDeployAt: '2026-09-02T00:00:00Z', lastPushAt: '2026-09-06T00:00:00Z' })],
      [],
      [],
      { now: TO, recentDays: 30 },
    );
    const row = out.projects.find((p) => p.projectId === 'proj');
    expect(row, '夹具没造出这个项目行').toBeTruthy();
    expect(row!.lastActivityAt, '只认部署的话这里会是 09-02').toContain('2026-09-06');
  });
});

describe('术语转正之后，模板不能再教作者写旧词', () => {
  /*
   * 本 PR 在 SSOT 规则里把 conditional 的中文定为「原则性通过」，归档门禁两种写法都收
   * （存量与在途报告不被拒），于是从旧模板生成的新报告会一直违反新用词而不会失败——
   * 一条不会红的规则等于没有规则（predicate-and-wiring-discipline 形状 4）。
   */
  const ROOT = path.resolve(process.cwd(), '..');
  const authoring = [
    '.claude/skills/create-visual-test-to-kb/templates/report-template.md',
    '.claude/skills/create-visual-test-to-kb/templates/module-visual-report.md',
    '.claude/skills/create-visual-test-to-kb/templates/zz-report.md',
    '.claude/skills/acceptance-scenario-orchestrator/references/evidence-contract.md',
  ];

  it('四份会被照抄进新报告的模板都已改用新词', () => {
    for (const rel of authoring) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text, `${rel} 还在教作者写「有条件通过」`).not.toContain('有条件通过');
      expect(text, `${rel} 里没有出现新词，可能是文件挪了位置`).toContain('原则性通过');
    }
  });

  it('归档门禁仍然两种写法都收，存量与在途报告不受影响', () => {
    const gate = fs.readFileSync(path.join(ROOT, '.claude/skills/create-visual-test-to-kb/scripts/archive_report.py'), 'utf8');
    expect(gate, '门禁把旧写法也拒了，存量报告会被挡在外面').toContain('"有条件通过"');
    expect(gate).toContain('"原则性通过"');
  });
});

describe('阻断缺陷压过安全结论（第十九轮）', () => {
  /*
   * 写入侧允许 verdict=pass 配 P0>0，而首屏原本只在 verdict==='fail' 时才看缺陷数，
   * 于是同一份报告在首屏是「可以正常使用」、在台账里列着阻断缺陷。
   * 验收规范本身写着「P0/P1 存在，总 Verdict 不得 pass」。
   */
  it('verdict 为 pass 但有 P0 时，首屏判「有功能坏了」', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 丁 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p0: 3 } }),
    ], [], { to: TO, days: 7 });
    // 前置条件：夹具写的是 pass，而生效结论已被阻断缺陷压成 fail——
    // 计数在 toRef 那个边界上就换算过了，所以这里 pass 是 0、fail 是 1。
    expect(o.totals.counted).toBe(1);
    expect(o.totals.pass).toBe(0);
    expect(o.totals.fail).toBe(1);
    expect(o.headline.status).toBe('broken');
    expect(o.headline.statusLabel).not.toBe('可以正常使用');
  });

  it('原则性通过带 P1 同样判「有功能坏了」', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 戊 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'conditional', defectCounts: { p1: 1 } }),
    ], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('broken');
  });

  it('干净的通过报告不受影响', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 己 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p2: 4 } }),
    ], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('ok');
    expect(o.headline.statusLabel).toBe('可以正常使用');
  });

  it('未通过且完全没记缺陷仍按产品坏了处理（不知道不等于没有）', () => {
    const o = buildReportsOverview([
      report({ title: '功能验收 · 庚 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'fail' }),
    ], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('broken');
  });
});
