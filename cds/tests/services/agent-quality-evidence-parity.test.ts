import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactQualityGate } from '../../src/services/agent-workspace-session-runtime';

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
});
