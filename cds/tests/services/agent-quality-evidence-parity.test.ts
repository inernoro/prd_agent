import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactQualityGate, knowledgeEvidenceOf } from '../../src/services/agent-workspace-session-runtime';
import { createArtifactQualityGate as createRuntimeGate, knowledgeEvidenceOf as runtimeEvidenceOf } from '../../../design-runtime/opendesign/src/quality/gate';

/**
 * 同一页面在执行器的质量闸里通过、到 MAP 发布闸才被拒，用户白等一整轮——根因是两道闸的证据口径分裂：
 * MAP（HostedSiteEditRunWorker.BuildQualityEvidence）明确不把用户写的标题与要求当证据，
 * 执行器这边却算进去了（判据与接线纪律 形状 3，Codex P2，2026-09-24）。
 * 两份执行器（CDS 会话运行时、独立设计执行服务）都只许用「不含标题与要求」的证据。
 */
const RUNTIMES = [
  path.join(process.cwd(), 'src/services/agent-workspace-session-runtime.ts'),
  path.join(process.cwd(), '../design-runtime/opendesign/src/executor.ts'),
];

describe('执行器质量闸与 MAP 发布闸同一证据口径', () => {
  for (const file of RUNTIMES) {
    it(`${path.basename(file)} 只用不含标题与要求的证据`, () => {
      const source = fs.readFileSync(file, 'utf8');
      // 调用点一律显式传 false；单参数调用（默认把标题与要求算进证据）不许再出现。
      const calls = (source.match(/collectArtifactQualityEvidence\([^)]*\)/g) ?? [])
        .filter((call) => !call.includes(':')); // 去掉函数定义本身（带类型标注的形参）
      expect(calls.length, '找不到证据收集调用，结构可能被挪走了').toBeGreaterThan(0);
      expect(calls.filter((call) => !/,\s*false\)$/.test(call))).toEqual([]);
    });
  }

  it('只出现在用户要求里的日期，页面引用它会被闸拒收并进入修复回路', () => {
    const gate = createArtifactQualityGate('知识库正文：本次改造分三步推进，负责人是平台组。');
    const html = '<!doctype html><html><head><title>t</title></head><body><main><h1>改造方案</h1>'
      + '<p>本次改造分三步推进，负责人是平台组，计划 2026-10-01 上线。</p></main></body></html>';
    expect(() => gate(html)).toThrow(/unsupported date, contact, or URL/);
  });

  // 2026-09-24 真人验收：知识是 HTML 日报，「主干落地 <b>31</b> 次真实提交」，页面写「31 次真实提交」被判成
  // 来源里没有的数字。三道闸（MAP、CDS、独立服务）都要把 HTML 知识的可见文字算进证据。
  const knowledge = '<p>主干落地 <b>31</b> 次真实提交，9 处修复封堵私有工作区。</p>';
  const page = '<!doctype html><html><head><title>t</title></head><body><main><h1>本周进展</h1>'
    + '<p>主干落地 31 次真实提交，9 处修复封堵私有工作区。</p></main></body></html>';
  for (const [name, gateOf, evidenceOf] of [
    ['CDS 会话运行时', createArtifactQualityGate, knowledgeEvidenceOf],
    ['独立设计执行服务', createRuntimeGate, runtimeEvidenceOf],
  ] as const) {
    it(`${name}：HTML 知识里被标签隔开的数字仍能支撑页面`, () => {
      // companion：只拿原文比对确实会拒收，说明这条用例测到了修复本身。
      expect(() => gateOf(knowledge)(page)).toThrow();
      expect(() => gateOf(evidenceOf(knowledge))(page)).not.toThrow();
    });
    it(`${name}：Markdown 知识原样保留，不被当标签剥掉`, () => {
      expect(evidenceOf('阈值 a < b 时切换')).toBe('阈值 a < b 时切换');
    });
  }
});

