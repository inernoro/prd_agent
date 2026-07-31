/**
 * CDS 自更新失败归因守卫。
 *
 * 背景：用户 2026-07-30 反馈「为什么 cds 普通更新总是有问题报错，还是英文错」。
 * 根因是每个失败点都把 git / pnpm / tsc / esbuild 的原始英文 stderr 套一句中文壳
 * 直接抛给用户——壳是中文，芯是英文，而芯才是需要读懂的那部分。
 *
 * 本测试锁三件事：
 *   1. 每种失败形态都归到**不同**的中文原因，不许一句「更新失败」糊弄过去；
 *   2. 任何失败都同时给出原因**和**恢复动作，不许只报错不给出路；
 *   3. 英文原文只能待在 raw 字段里，绝不能升级成主文案（这正是被投诉的那件事）。
 */

import { describe, it, expect } from 'vitest';
import {
  diagnoseSelfUpdateFailure,
  formatSelfUpdateFailureMessage,
  type SelfUpdateFailureStage,
} from '../../src/services/self-update-failure-diagnosis.js';

/** 判定「这段文本是给人读的中文」而不是透传的英文原文。 */
function isChineseProse(text: string): boolean {
  return /[一-龥]/.test(text);
}

describe('diagnoseSelfUpdateFailure', () => {
  it('git 认证失败归因到凭据，而不是把英文原文当主文案', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'fetch',
      raw: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
    expect(d.cause).toContain('认证');
    expect(isChineseProse(d.cause)).toBe(true);
    // 关键反向断言：被投诉的那段英文不许出现在主文案里。
    expect(d.cause).not.toContain('could not read Username');
    expect(d.nextAction).not.toContain('could not read Username');
    // 但原文必须完整保留下来，供需要的人展开看。
    expect(d.raw).toContain('could not read Username');
  });

  it('网络不通与认证失败是两种不同的原因', () => {
    const auth = diagnoseSelfUpdateFailure({ stage: 'fetch', raw: 'fatal: Authentication failed' });
    const network = diagnoseSelfUpdateFailure({
      stage: 'fetch',
      raw: 'fatal: unable to access: Could not resolve host: github.com',
    });
    expect(network.cause).not.toBe(auth.cause);
    expect(network.cause).toContain('网络');
  });

  it('锁文件过期指向开发端重新生成，而不是让用户去生产机瞎试', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'install',
      raw: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
    });
    expect(d.cause).toContain('锁文件');
    expect(d.nextAction).toContain('pnpm install');
  });

  it('类型检查失败要说清「旧版本还在跑」，避免用户以为 CDS 挂了', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'typecheck',
      raw: "src/index.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    });
    expect(d.cause).toContain('类型检查');
    expect(d.cause).toContain('旧版本');
    expect(d.raw).toContain('error TS2322');
  });

  it('磁盘满不会被误判成它伪装的那一步的错', () => {
    // 磁盘满会让任意一步失败，所以它必须优先于阶段兜底命中。
    const d = diagnoseSelfUpdateFailure({
      stage: 'build',
      raw: 'Error: ENOSPC: no space left on device, write',
    });
    expect(d.cause).toContain('磁盘');
    expect(d.nextAction).toContain('清理');
  });

  it('防覆盖闸门要说清这不是故障，并指向强制更新入口', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'gate',
      code: 'non_fast_forward_update_requires_intent',
      message: '目标版本不包含当前 CDS 提交（非快进切换）。',
    });
    expect(d.cause).toContain('目标版本不包含当前 CDS 提交');
    expect(d.nextAction).toContain('不是故障');
    expect(d.nextAction).toContain('强制更新');
    // 机器码是给日志看的，不许出现在给人读的两段文案里。
    expect(d.cause).not.toContain('non_fast_forward');
    expect(d.nextAction).not.toContain('non_fast_forward');
  });

  it('每个闸门 code 都有自己的恢复动作，不共用一句套话', () => {
    const codes = [
      'non_fast_forward_update_requires_intent',
      'invalid_transition_intent',
      'expected_from_sha_required',
      'expected_from_sha_mismatch',
      'transition_reason_required',
    ];
    const actions = codes.map(
      (code) => diagnoseSelfUpdateFailure({ stage: 'gate', code, message: '闸门拦截。' }).nextAction,
    );
    expect(new Set(actions).size).toBe(codes.length);
  });

  it('任何阶段、任何输入都同时给出中文原因和恢复动作', () => {
    const stages: SelfUpdateFailureStage[] = [
      'concurrency', 'fetch', 'gate', 'checkout', 'reset',
      'install', 'typecheck', 'build', 'swap', 'restart', 'unknown',
    ];
    for (const stage of stages) {
      for (const raw of ['', 'some opaque english failure', '  ']) {
        const d = diagnoseSelfUpdateFailure({ stage, raw });
        expect(isChineseProse(d.cause), `${stage} cause 必须是中文`).toBe(true);
        expect(isChineseProse(d.nextAction), `${stage} nextAction 必须是中文`).toBe(true);
        expect(d.nextAction.length, `${stage} 不许只报错不给出路`).toBeGreaterThan(0);
      }
    }
  });

  it('未归类的英文原文不会被偷偷升级成主文案', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'unknown',
      raw: 'panic: something nobody has a rule for yet',
      message: 'panic: something nobody has a rule for yet',
    });
    // message 是英文时必须走中文兜底，而不是把英文当 cause 端出去。
    expect(isChineseProse(d.cause)).toBe(true);
    expect(d.cause).not.toContain('panic');
    expect(d.raw).toContain('panic');
  });

  it('调用点已有的中文说明比阶段兜底更具体，应当被保留', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'checkout',
      message: '分支切换未生效: 仍在 main',
    });
    expect(d.cause).toBe('分支切换未生效: 仍在 main');
  });

  it('超长原始输出被截断但保留可读开头', () => {
    const d = diagnoseSelfUpdateFailure({ stage: 'build', raw: 'x'.repeat(5000) });
    expect(d.raw.length).toBeLessThan(1400);
    expect(d.raw).toContain('已截断');
  });

  it('兼容旧前端的单串文案里两段都在，且不是英文原文', () => {
    const d = diagnoseSelfUpdateFailure({
      stage: 'fetch',
      raw: 'fatal: Authentication failed for https://github.com',
    });
    const msg = formatSelfUpdateFailureMessage(d);
    expect(msg).toContain(d.cause);
    expect(msg).toContain(d.nextAction);
    expect(msg).toContain('下一步');
    expect(msg).not.toContain('Authentication failed');
  });
});
