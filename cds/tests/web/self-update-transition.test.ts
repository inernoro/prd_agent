/**
 * self-update-transition.test.ts —— 「强制更新」必须带上版本切换声明。
 *
 * 事故（2026-07-30 用户实拍）：点写着「强制更新」的按钮，被回
 * 「目标版本不包含当前 CDS 提交；必须显式声明 release 或 rollback」。
 * 根因是前端只发 `{ branch, force }`，后端 `evaluateSelfUpdateTransition`
 * 要的 `transitionIntent` / `expectedFromSha` / `transitionReason` 一个都没发——
 * 闸门后加、UI 没跟上，而失败信息又反过来要求用户做他刚做过的事。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildForceSyncBody,
  defaultTransitionReason,
  forceSyncBlockedReason,
  validateTransitionReason,
  TRANSITION_REASON_MIN,
} from '../../web/src/lib/selfUpdateTransition';
import { evaluateSelfUpdateTransition } from '../../src/services/self-update-checkout.js';

const HEAD = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);

describe('buildForceSyncBody', () => {
  it('三个声明字段一个不漏', () => {
    const body = buildForceSyncBody({
      headSha: HEAD, targetBranch: 'claude/x', intent: 'release', reason: '从 CDS 系统设置强制发布到 claude/x',
    });
    expect(body).toEqual({
      branch: 'claude/x',
      force: true,
      transitionIntent: 'release',
      expectedFromSha: HEAD,
      transitionReason: '从 CDS 系统设置强制发布到 claude/x',
    });
  });

  it('分支为空时不发 branch 字段（让后端按当前分支推荐）', () => {
    const body = buildForceSyncBody({ headSha: HEAD, targetBranch: '  ', intent: 'rollback', reason: '回滚到稳定版本' });
    expect('branch' in body).toBe(false);
    expect(body.transitionIntent).toBe('rollback');
  });
});

/**
 * 这一段才是这次事故的核心断言：把前端组的 body 直接喂给**后端那个真判据**，
 * 断言它放行。只测「body 长什么样」不够——字段名拼错、intent 取值不合法，
 * body 照样"看起来对"，而线上照样被拒。
 */
describe('前端组的 body 能过后端闸门', () => {
  it('非快进切换 + 完整声明 → 放行', () => {
    const body = buildForceSyncBody({
      headSha: HEAD, targetBranch: 'claude/x', intent: 'release', reason: '从 CDS 系统设置强制发布到 claude/x',
    });
    const decision = evaluateSelfUpdateTransition({
      currentSha: HEAD,
      targetSha: TARGET,
      targetContainsCurrent: false,
      intent: body.transitionIntent,
      expectedFromSha: body.expectedFromSha,
      reason: body.transitionReason,
    });
    expect(decision.allowed).toBe(true);
    expect(decision).toMatchObject({ mode: 'release' });
  });

  it('回滚同样放行', () => {
    const body = buildForceSyncBody({
      headSha: HEAD, targetBranch: 'main', intent: 'rollback', reason: '回滚到上一个稳定版本',
    });
    const decision = evaluateSelfUpdateTransition({
      currentSha: HEAD,
      targetSha: TARGET,
      targetContainsCurrent: false,
      intent: body.transitionIntent,
      expectedFromSha: body.expectedFromSha,
      reason: body.transitionReason,
    });
    expect(decision).toMatchObject({ allowed: true, mode: 'rollback' });
  });

  it('这就是修复前的样子：只发 branch + force → 被拒', () => {
    const decision = evaluateSelfUpdateTransition({
      currentSha: HEAD,
      targetSha: TARGET,
      targetContainsCurrent: false,
    });
    expect(decision).toMatchObject({
      allowed: false,
      code: 'non_fast_forward_update_requires_intent',
    });
  });

  it('快进切换时这些字段无害（所以前端无条件带上，不做客户端预测）', () => {
    const body = buildForceSyncBody({
      headSha: HEAD, targetBranch: 'main', intent: 'release', reason: '从 CDS 系统设置强制发布到 main',
    });
    expect(evaluateSelfUpdateTransition({
      currentSha: HEAD,
      targetSha: TARGET,
      targetContainsCurrent: true,
      intent: body.transitionIntent,
      expectedFromSha: body.expectedFromSha,
      reason: body.transitionReason,
    })).toMatchObject({ allowed: true, mode: 'fast-forward' });
  });
});

describe('默认原因与校验', () => {
  it('默认原因说得出「谁在哪儿干了什么」，且长度达标', () => {
    const reason = defaultTransitionReason('release', 'claude/cds-release-center-redesign-leqn3z');
    expect(reason).toContain('CDS 系统设置');
    expect(reason).toContain('claude/cds-release-center-redesign-leqn3z');
    expect(reason.trim().length).toBeGreaterThanOrEqual(TRANSITION_REASON_MIN);
    expect(validateTransitionReason(reason)).toBeUndefined();
  });

  it('回滚与发布的默认原因不同（审计里要能区分）', () => {
    expect(defaultTransitionReason('rollback', 'main'))
      .not.toBe(defaultTransitionReason('release', 'main'));
  });

  it('默认原因能过后端的长度/字符校验', () => {
    for (const intent of ['release', 'rollback'] as const) {
      const reason = defaultTransitionReason(intent, 'main');
      const decision = evaluateSelfUpdateTransition({
        currentSha: HEAD, targetSha: TARGET, targetContainsCurrent: false,
        intent, expectedFromSha: HEAD, reason,
      });
      expect(decision.allowed, `${intent}: ${reason}`).toBe(true);
    }
  });

  it('太短 / 太长 / 含控制字符都拦下', () => {
    expect(validateTransitionReason('短')).toContain('至少');
    expect(validateTransitionReason('x'.repeat(301))).toContain('最多');
    expect(validateTransitionReason(`ok${String.fromCharCode(7)}ok-reason`)).toContain('控制字符');
  });

  it('读不到当前 sha 时不许发起——那把乐观锁不能交出去', () => {
    expect(forceSyncBlockedReason('', '从 CDS 系统设置强制发布到 main')).toContain('刷新');
    expect(forceSyncBlockedReason(HEAD, '从 CDS 系统设置强制发布到 main')).toBeUndefined();
  });
});

describe('UI 真的把声明发出去了（接线守卫）', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../web/src/pages/cds-settings/tabs/MaintenanceTab.tsx',
    ),
    'utf8',
  );

  it('强制更新按钮走 buildForceSyncBody，而不是裸 { force: true }', () => {
    expect(source).toContain('buildForceSyncBody({');
    expect(source).toContain("runSelfUpdate('/api/self-force-sync'");
    // 只传 force 就是修复前的形状。
    expect(source).not.toMatch(/runSelfUpdate\('\/api\/self-force-sync',\s*'强制更新',\s*\{\s*force:\s*true\s*\}\)/);
  });

  it('expectedFromSha 取自 self-status 的 headSha，不是用户手填', () => {
    expect(source).toMatch(/const forceHeadSha = selfStatus\.status === 'ok'/);
    expect(source).toContain('headSha: forceHeadSha');
  });

  it('原因不合法时禁用确认按钮，不让用户点了才吃后端报错', () => {
    expect(source).toContain('disabled={Boolean(forceBlockedReason)}');
  });

  it('对话框里能选发布还是回滚', () => {
    expect(source).toContain('setForceIntent');
    expect(source).toContain('发布新版本');
    expect(source).toContain('回滚旧版本');
  });
});
