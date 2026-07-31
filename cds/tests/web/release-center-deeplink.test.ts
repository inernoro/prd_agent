/**
 * release-center-deeplink.test.ts — 发布告警深链的 target / run 参数。
 *
 * 站内信里那条「查看发布记录」承诺打开出事的那个目标和那次发布
 * （notice-ledger 生成 `/release-center?project=&target=&run=`）。
 * 页面此前只读 project，多目标时会落到默认目标、也不会打开被点名的 run——
 * 运维顺着告警点进来看到的是一屏无关内容（Codex review P2，2026-07-29）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { releaseCenterDeepLink } from '../../web/src/lib/releaseCenter';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '../../web/src', rel), 'utf8');

describe('releaseCenterDeepLink', () => {
  it('解析 notice-ledger 产出的完整深链', () => {
    const params = new URLSearchParams('project=p1&target=rt_prod&run=rel_abc');
    expect(releaseCenterDeepLink(params)).toEqual({ targetId: 'rt_prod', runId: 'rel_abc' });
  });

  it('只带 target 时不编一个 run 出来', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('project=p1&target=rt_prod')))
      .toEqual({ targetId: 'rt_prod' });
  });

  it('只带 run 时不编一个 target 出来', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('run=rel_abc')))
      .toEqual({ runId: 'rel_abc' });
  });

  it('没有定位参数时返回空对象，页面按默认行为走', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('project=p1'))).toEqual({});
  });

  it('空白值当没给（`?target=` 这种残缺链接不该把选中态清成空）', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('target=&run=%20'))).toEqual({});
  });
});

describe('页面真的消费了这两个参数（接线守卫）', () => {
  const page = read('pages/ReleaseCenterPage.tsx');

  it('初始选中态取自深链的 target', () => {
    expect(page).toContain('releaseCenterDeepLink');
    expect(page).toMatch(/useState\(deepLink\.targetId \|\| ''\)/);
  });

  it('深链点名的 run 会被打开成日志弹窗', () => {
    // 只断言「有人调用」不够：得断言它真的落到 setLogRun，
    // 否则参数解析了、选中了目标，弹窗仍然不开，用户还是看不到那次失败。
    const effect = page.slice(page.indexOf('pendingRunId'), page.indexOf('const selectedRow'));
    expect(effect).toMatch(/runs\.find\(\(run\) => run\.releaseId === pendingRunId\)/);
    expect(effect).toContain('setLogRun(target)');
    expect(effect).toContain('setSelectedTargetId(target.targetId)');
  });

  it('只弹一次：pending 用完即清，用户关掉不会被弹回来', () => {
    const effect = page.slice(page.indexOf('pendingRunId'), page.indexOf('const selectedRow'));
    expect(effect).toContain("setPendingRunId('')");
  });

  it('通知侧仍然在链接里带上 target 与 run（两头都在才叫一条链路）', () => {
    const ledger = fs.readFileSync(path.resolve(here, '../../src/services/notice-ledger.ts'), 'utf8');
    expect(ledger).toContain("params.set('target', data.targetId)");
    expect(ledger).toContain("params.set('run', data.releaseId)");
  });
});

/**
 * 待人工确认的深链：`?target=&branch=&commit=`。
 *
 * 定时规则要求人工确认时不自动发布，只留一条通知。人可能几小时后才点进来，
 * 那时分支早已前进——链接不钉死 commit，批准发出去的就不是刚才过检的那一版
 * （Codex review P1，2026-07-29）。
 */
describe('待人工确认深链钉住版本', () => {
  const page = read('pages/ReleaseCenterPage.tsx');

  it('解析 branch 与 commit', () => {
    const params = new URLSearchParams('project=p1&target=rt_prod&branch=br_main&commit=abc123');
    expect(releaseCenterDeepLink(params)).toEqual({
      targetId: 'rt_prod', branchId: 'br_main', commitSha: 'abc123',
    });
  });

  it('只有 branch 没有 commit 时不算一条完整的审批链接', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('target=rt_prod&branch=br_main')))
      .toEqual({ targetId: 'rt_prod', branchId: 'br_main' });
  });

  it('通知侧把 branch 与 commit 写进链接（两头都在才叫一条链路）', () => {
    const ledger = fs.readFileSync(path.resolve(here, '../../src/services/notice-ledger.ts'), 'utf8');
    expect(ledger).toContain("params.set('branch', data.branchId)");
    expect(ledger).toContain("params.set('commit', data.commitSha)");
  });

  it('调度侧把过检的那一版随事件带出去', () => {
    const svc = fs.readFileSync(path.resolve(here, '../../src/services/scheduled-job-service.ts'), 'utf8');
    // 事件里没有 commitSha，notice-ledger 就拼不出 commit 参数，整条链断在源头。
    expect(svc).toMatch(/candidate\?\.commitSha \? \{ commitSha: candidate\.commitSha \}/);
    expect(svc).toMatch(/\{ branchId: source\.branchId, \.\.\.\(source\.candidateCommitSha/);
  });

  it('页面把 commit 钉进发布意图，而不只是选中目标', () => {
    // 只选中目标 = 打开的仍是「发当前最新」，等于没钉。
    const effect = page.slice(page.indexOf('pendingApproval'), page.indexOf('const selectedRow'));
    expect(effect).toContain('expectedCommitSha: pendingApproval.commitSha');
    expect(effect).toContain('branchId: pendingApproval.branchId');
    expect(effect).toContain('setReleaseIntent');
  });

  it('三个参数缺一就不进审批流程（不猜）', () => {
    const init = page.slice(page.indexOf('const [pendingApproval'), page.indexOf('const [releaseIntent'));
    expect(init).toMatch(/deepLink\.targetId && deepLink\.branchId && deepLink\.commitSha/);
  });
});

describe('待人工确认时预检失败必须记成失败', () => {
  it('preflight 不 ok 就返回失败结果，而不是 skip', async () => {
    const svc = fs.readFileSync(path.resolve(here, '../../src/services/scheduled-job-service.ts'), 'utf8');
    const branch = svc.slice(svc.indexOf('if (target.requireApproval)'), svc.indexOf('// f) 试跑模式'));
    // 记成 skip 会顺带清零 consecutiveFailureCount，于是一条每次都过不了预检的规则
    // 永远够不到自动停用阈值。
    expect(branch).toContain('if (!preflight.ok) return preflight;');
    expect(branch.indexOf('if (!preflight.ok) return preflight;'))
      .toBeLessThan(branch.indexOf("return skip('已生成待人工确认通知"));
  });
});
