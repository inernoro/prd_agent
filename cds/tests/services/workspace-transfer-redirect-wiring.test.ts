import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNTIME = path.join(process.cwd(), 'src/services/agent-workspace-session-runtime.ts');

/**
 * 伙伴侧传输的 origin 在会话创建时被钉死，但 fetch 默认跟随 3xx——跟过去的那一跳
 * 不再受钉定约束。唯一入口是 fetchPartnerTransfer；这条守卫盯的是「以后有人新写
 * 一处伙伴请求时绕过它」（判据与接线纪律 形状 2/3：链路只建一半、判据分裂漂移）。
 */
describe('伙伴侧传输不跟随重定向', () => {
  const source = fs.readFileSync(RUNTIME, 'utf8');

  it('唯一入口强制 redirect: manual 并把 3xx 判成失败', () => {
    const helper = source.slice(source.indexOf('private async fetchPartnerTransfer'));
    const body = helper.slice(0, helper.indexOf('\n  }\n'));
    expect(body).toContain("redirect: 'manual'");
    expect(body).toContain('workspace_transfer_redirect_rejected');
  });

  it('两个伙伴 URL 都不再直接进 this.fetchImpl', () => {
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), no: index + 1 }))
      .filter((item) => item.line.includes('this.fetchImpl(')
        && (item.line.includes('inputPackageUrl') || item.line.includes('resultCommitUrl')));
    expect(offenders.map((item) => `${item.no}: ${item.line}`)).toEqual([]);
  });

  it('伙伴 URL 确实走了唯一入口（守卫不会因为调用点整个消失而空转）', () => {
    const calls = source
      .split('\n')
      .filter((line) => line.includes('this.fetchPartnerTransfer('));
    expect(calls).toHaveLength(2);
    expect(calls.some((line) => line.includes('inputPackageUrl'))).toBe(true);
    expect(calls.some((line) => line.includes('resultCommitUrl'))).toBe(true);
  });
});
