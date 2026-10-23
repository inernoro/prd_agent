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
  validateTransitionReason,
  TRANSITION_REASON_MIN,
} from '../../web/src/lib/selfUpdateTransition';
import {
  evaluateSelfUpdateTransition,
  resolveForceSyncTransition,
} from '../../src/services/self-update-checkout.js';

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

  it('读不到当前 sha 也照样能组出请求体——强制更新不设前置条件', () => {
    // 曾经这里有个 forceSyncBlockedReason，缺 headSha / 原因不合法就禁用按钮。
    // 那是把后端刚拆掉的闸又装回 UI 侧：强制更新是用户控制 CDS 的最后手段，
    // 它必须在任何状态下都能发起。
    const body = buildForceSyncBody({ headSha: '', targetBranch: 'main', intent: 'release', reason: '' });
    expect(body.force).toBe(true);
    expect(body.expectedFromSha).toBe('');
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

  it('绝不因为审计字段不完整就禁用确认按钮', () => {
    // 强制更新不能有任何 UI 侧前置条件。出现这类 disabled 就是又给逃生门上了锁。
    expect(source).not.toContain('disabled={Boolean(forceBlockedReason)}');
    expect(source).not.toContain('forceSyncBlockedReason');
  });

  it('对话框里能选发布还是回滚', () => {
    expect(source).toContain('setForceIntent');
    expect(source).toContain('发布新版本');
    expect(source).toContain('回滚旧版本');
  });
});

/**
 * 强制更新 = 逃生门，**永不拒绝**。
 *
 * 用户 2026-07-30 定的原则：「强制更新一定是忽略所有条件，不然用户没有任何手段
 * 控制 CDS」。旧实现让 /api/self-force-sync 也走严格闸门，hint 里还写着
 * 「强制同步不能绕过版本继承门禁」——等于给逃生门上了锁。
 */
describe('resolveForceSyncTransition 永不拒绝', () => {
  const nonFf = { currentSha: HEAD, targetSha: TARGET, targetContainsCurrent: false };

  it('非快进 + 什么都不声明 → 照样放行（这正是修复前会被拒的那一种）', () => {
    const decision = resolveForceSyncTransition(nonFf);
    expect(decision.mode).toBe('release');
    expect(decision.reason).toContain('未声明');
    // 对照组：同样的输入喂给普通更新那道严格闸门，会被拒。两条路径语义不同。
    expect(evaluateSelfUpdateTransition(nonFf)).toMatchObject({ allowed: false });
  });

  it('原因太短也照记原文——那是用户真写的字，不该被换成「未声明」', () => {
    // 8 字符下限属于普通更新那道严格闸门；强制路径没有下限，
    // 把「短」改写成「未声明」等于在审计记录里造假。
    expect(resolveForceSyncTransition({ ...nonFf, reason: '短' }).reason).toBe('短');
  });

  it('含控制字符才退回默认（那会让审计记录出现不可见内容）', () => {
    expect(resolveForceSyncTransition({ ...nonFf, reason: `x${String.fromCharCode(7)}y` }).reason)
      .toContain('未声明');
    expect(resolveForceSyncTransition({ ...nonFf, reason: '   ' }).reason).toContain('未声明');
  });

  it('expectedFromSha 完全不参与——强制路径不做乐观锁', () => {
    // 函数签名里压根没有这个字段：有的话早晚会有人拿它做拦截。
    expect(Object.keys(resolveForceSyncTransition(nonFf))).toEqual(['mode', 'reason']);
  });

  it('声明了就照实记，供审计', () => {
    expect(resolveForceSyncTransition({ ...nonFf, intent: 'rollback', reason: '回滚到上一个稳定版本' }))
      .toEqual({ mode: 'rollback', reason: '回滚到上一个稳定版本' });
  });

  it('没声明 intent 的非快进记为 release，不记 rollback', () => {
    // 记成 rollback 会在审计里造出「回滚到一个更新的版本」这种自相矛盾的记录。
    expect(resolveForceSyncTransition(nonFf).mode).toBe('release');
  });

  it('同 sha / 快进照常识别，日志文案才分得清', () => {
    expect(resolveForceSyncTransition({ ...nonFf, targetSha: HEAD }).mode).toBe('same-sha');
    expect(resolveForceSyncTransition({ ...nonFf, targetContainsCurrent: true }).mode).toBe('fast-forward');
  });

  it('原因超长截断到 300，不拒绝', () => {
    expect(resolveForceSyncTransition({ ...nonFf, reason: 'x'.repeat(400) }).reason).toHaveLength(300);
  });
});

describe('强制同步路由不再设闸（接线守卫）', () => {
  it('走 resolveForceSyncTransition，且不再有「不能绕过门禁」那句话', async () => {
    const routes = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes/branches.ts'),
      'utf8',
    );
    expect(routes).toContain('resolveForceSyncTransition({');
    expect(routes).not.toContain('强制同步不能绕过版本继承门禁');
    // 普通更新那条路径必须**保留**严格闸门 —— 两条路不能一起放开。
    expect(routes).toContain('evaluateSelfUpdateTransition({');
  });
});

/**
 * 日志故障仍可退回无日志启动；状态保存未确认则必须取消并恢复原版本。
 *
 * 2026-07-30 真实事故：一次强制同步把 dist/ 与 web/dist 都换成了新版本，进程却没重启
 * —— 生产是「新前端 + 旧后端」，而 lastSelfUpdate 写着 success。
 * 2026-10-20 获批新契约：不能把状态保存失败当普通日志故障，须取消已spawn脚本并回滚。
 */
describe('自更新重启的结构（源码守卫）', () => {
  const routes = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes/branches.ts'),
    'utf8',
  );
  const launch = routes.slice(
    routes.indexOf('async function scheduleDetachedCdsRestart'),
    routes.indexOf('async function flushBranchStateBeforeSuccess'),
  );
  const helper = fs.readFileSync(new URL('../../src/services/self-update-handoff.ts', import.meta.url), 'utf8');

  it('日志与FD记账各自容错，关键状态中断与保存不被吞掉', () => {
    expect(launch).toContain('const safely = (label: string, fn: () => void)');
    for (const step of ['open-log', 'open-log-fd', 'close-log-fd']) {
      expect(launch, step).toContain(`safely('${step}'`);
    }
    expect(launch).not.toContain("safely('interrupt-all'");
  });

  it('真实helper准备spawn，缺PID或保存未确认都取消而不退出', () => {
    expect(launch).toContain('prepareDetachedCdsRestart(spawn, cdsDir, { ...process.env }, stdio)');
    expect(helper).toContain("spawnProcess('bash', ['-p', '-c', CDS_RESTART_PERMIT_COMMAND]");
    expect(launch).toContain("saved !== 'flushed' || input.preserveQueued !== true || !permit?.hasChildPid");
    expect(launch).toContain('normalShutdown: input.preserveQueued === true && permit?.hasChildPid === true');
    expect(launch).toMatch(/await permit\?\.cancel\(\);\s+try \{\s*await input\.rollback\?\.\(\);\s*\}\s*finally \{/);
    expect(launch).toContain('if (operationsInterrupted && branchOperationCoordinator) deploymentRunService?.restoreQueued(branchOperationCoordinator);');
  });

  it('中断终态保存及pipe许可后才排退出，仍用原期限与开闸兜底', () => {
    const interruptAt = launch.indexOf('interruptAll('), flushAt = launch.indexOf('stateService.flush()');
    const permitAt = launch.indexOf('await permit.release()'), exitAt = launch.indexOf('process.exit(0)');
    expect(interruptAt).toBeGreaterThan(-1);
    expect(flushAt).toBeGreaterThan(interruptAt);
    expect(permitAt).toBeGreaterThan(flushAt);
    expect(exitAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(permitAt);
    expect(launch).toContain('setTimeout(() => process.exit(0), Math.max(0, deadline - Date.now()))');
    expect(launch).toContain('}, RESTART_GATE_RELEASE_MS).unref?.()');
  });

  it('stdio 打不开时退回 ignore，而不是放弃重启', () => {
    expect(launch).toContain("stdio: ['ignore', number | 'ignore', number | 'ignore']");
    expect(launch).toContain("= ['ignore', 'ignore', 'ignore']");
    expect(launch).toContain("fds.push(fs.openSync(errorLogPath, 'a'))");
    expect(helper).toContain("stdio: [...stdio, 'pipe']");
  });
});

describe('「更新成功但没重启」必须显眼且可一键补救（接线守卫）', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../web/src/pages/cds-settings/tabs/MaintenanceTab.tsx',
    ),
    'utf8',
  );

  it('incomplete 时给整条横幅，不只是一个小 chip', () => {
    expect(source).toContain("data.restartStatus === 'incomplete'");
    expect(source).toContain('新前端 + 旧后端');
  });

  it('横幅里带一键重启，打到 /api/self-restart', () => {
    expect(source).toContain('立即重启');
    expect(source).toContain("'/api/self-restart'");
  });
});
