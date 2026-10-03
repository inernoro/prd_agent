/**
 * 关系图几何判据（判据定义见 relation-geometry.ts 的 G1–G8）。
 *
 * 两组输入：
 * 1. 同构样本：与用户 2026-09-30 截图那条分支结构一致的合成数据（fixtures/relation-shape-alpha.json，
 *    不存真实快照，约定见 scripts/fixtures/mobile-layout-fixtures.mjs），从手机到超宽屏逐档宽度跑；
 *    本地想拿真实分支验：`cdscli topology <分支 id>` 存成文件，RELATION_SNAPSHOT=<文件> 再跑本测试，
 *    会多出一组用真实快照跑的同样断言；
 * 2. 随机样本：固定种子生成 300 份极端服务图（长名字、几十个子域、双公网面、互相依赖、基础设施、跨项目引用），
 *    每份跑 5 档宽度。失败信息里带种子与宽度，可原样复现。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { layoutRelations, type RelationPayload } from '../../web/src/components/branch/RelationGraph.js';
import { auditLayout, randomPayload } from './relation-geometry.js';

const SHAPE = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/relation-shape-alpha.json'), 'utf8')) as RelationPayload;
const HOST = 'feature-alpha-fixture-project.example.invalid';
const WIDTHS = [320, 360, 374, 390, 430, 560, 639, 640, 720, 768, 900, 1024, 1040, 1180, 1289, 1440, 1680, 1920, 2560];

/** 快照可以是 cdscli topology 的原样输出（{ ok, data }），也可以是 service-graph 响应本身 */
const loadSnapshot = (file: string): RelationPayload => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = raw.data ?? raw;
  return { branchId: d.branchId, projectId: d.projectId ?? 'snapshot', branch: d.branch ?? d.branchId, status: 'running', graph: d.graph, lint: d.lint, references: d.references ?? [] };
};
const samples: Array<[string, RelationPayload, string | undefined]> = [['同构样本 feature/alpha', SHAPE, HOST]];
if (process.env.RELATION_SNAPSHOT) samples.push([`真实快照 ${process.env.RELATION_SNAPSHOT}`, loadSnapshot(process.env.RELATION_SNAPSHOT), process.env.RELATION_SNAPSHOT_HOST]);

for (const [name, payload, host] of samples) {
  describe(name, () => {
    for (const width of WIDTHS) {
      it(`宽 ${width}：G1–G8 零违规`, () => {
        const report = auditLayout(layoutRelations(payload, width), payload, host);
        expect(report.violations, report.violations.join('\n')).toEqual([]);
      });
    }
  });
}

describe('同构样本没有被简化掉（它要替真实分支挡住同一批问题）', () => {
  it('13 个服务、3 个基础设施、5 条依赖、8 个子域、4 个前缀成员、1 个内网服务、1 处双公网面', () => {
    expect(SHAPE.graph.nodes.filter((n) => n.kind === 'service')).toHaveLength(13);
    expect(SHAPE.graph.nodes.filter((n) => n.kind === 'infra')).toHaveLength(3);
    expect(SHAPE.graph.edges).toHaveLength(5);
    expect(SHAPE.graph.sites.filter((s) => s.kind === 'subdomain')).toHaveLength(8);
    expect(SHAPE.graph.sites.find((s) => s.kind === 'main')!.members).toHaveLength(4);
    expect(SHAPE.graph.internal).toHaveLength(1);
    expect(SHAPE.lint.findings.map((f) => f.rule)).toContain('double-public-surface');
  });
});

describe('随机极端样本（固定种子，可复现）', () => {
  const failures: string[] = [];
  const widths = [320, 390, 768, 1289, 1920];
  for (let seed = 1; seed <= 300; seed += 1) {
    const p = randomPayload(seed);
    for (const width of widths) {
      const report = auditLayout(layoutRelations(p, width), p);
      if (report.violations.length) failures.push(`seed=${seed} width=${width}\n  ${report.violations.slice(0, 4).join('\n  ')}`);
    }
  }
  it('300 份 × 5 档宽度，G1–G8 零违规', () => {
    expect(failures.length, failures.slice(0, 12).join('\n')).toBe(0);
  });
});
