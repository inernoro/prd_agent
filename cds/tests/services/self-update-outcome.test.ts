import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reconcileSelfUpdateOutcome } from '../../src/services/self-update-outcome.js';

/**
 * E37 的回归：更新记录说「成功」，实际早已回滚。
 *
 * 2026-08-18 那次，构建、tsc、web bundle 全跑完，历史里写着 status success、
 * toSha 新版本、error null；而机器上 HEAD 是旧版、detached。新版本启动即崩溃，
 * systemd 重试超限后退回。回滚在任何地方都查不到，连一条 error 都没有。
 *
 * 症结是判据取错了时刻：**「构建成功」被当成了「更新成功」**。真正的判据只有一个
 * ——重启之后 HEAD 是不是目标 sha。
 */
describe('自更新结果对账', () => {
  it('声称成功、HEAD 也对得上：真的落地了', () => {
    const r = reconcileSelfUpdateOutcome({ toSha: '38661d13', status: 'success' }, '38661d13a');
    expect(r.rolledBack).toBe(false);
    expect(r.message).toContain('已落地');
  });

  it('声称成功、HEAD 却是旧版：判为被退回', () => {
    // 这一条就是事故原形：记录 success + toSha 6d2da7de，实际 HEAD b4b6b01b。
    const r = reconcileSelfUpdateOutcome({ toSha: '6d2da7de', status: 'success' }, 'b4b6b01be');
    expect(r.rolledBack).toBe(true);
    expect(r.message).toContain('中途被退回');
    expect(r.claimedSha).toBe('6d2da7de');
    expect(r.actualSha).toBe('b4b6b01be');
  });

  it('长短 sha 混着写也能对上', () => {
    const long = '38661d13ace7f1a24fa41066220bd9ceb9d89338';
    expect(reconcileSelfUpdateOutcome({ toSha: '38661d13a', status: 'success' }, long).rolledBack).toBe(false);
    expect(reconcileSelfUpdateOutcome({ toSha: long, status: 'success' }, '38661d13a').rolledBack).toBe(false);
  });

  it('记录本来就没声称成功：不翻案', () => {
    const r = reconcileSelfUpdateOutcome({ toSha: 'aaaaaaa1', status: 'failed' }, 'bbbbbbb2');
    expect(r.rolledBack).toBe(false);
  });

  it('读不出 sha 时不下结论——编一个「已回滚」同样是假话', () => {
    // 不确定不等于失败。这里宁可说「无法对账」，也不许猜。
    for (const [claim, head] of [[{ toSha: '', status: 'success' }, 'abc1234'],
                                 [{ toSha: 'abc1234', status: 'success' }, '']] as const) {
      const r = reconcileSelfUpdateOutcome(claim, head);
      expect(r.rolledBack).toBe(false);
      expect(r.message).toContain('无法对账');
    }
  });

  it('sha 太短判为无效，不做前缀误配', () => {
    // 「a」和「abcdef1」共同前缀相同，但那不构成同一个版本的证据。
    const r = reconcileSelfUpdateOutcome({ toSha: 'a', status: 'success' }, 'abcdef1');
    expect(r.rolledBack).toBe(true);
  });

  it('没有任何记录：不翻案', () => {
    expect(reconcileSelfUpdateOutcome(null, 'abc1234').rolledBack).toBe(false);
    expect(reconcileSelfUpdateOutcome(undefined, 'abc1234').rolledBack).toBe(false);
  });
});

/** 接线守卫：对账写好没人调，表现和「一切正常」一模一样。 */
describe('对账真的接在重启之后', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('daemon ready 之后就对账', () => {
    const ready = SRC.indexOf('recordDaemonReady()');
    // 必须找**调用点**：只搜函数名会先命中上面的函数声明，那样这条守卫
    // 测的是「声明在 ready 之后」，永远不成立，和它想守的事无关。
    const call = SRC.indexOf('void reconcileSelfUpdateAfterRestart();');
    expect(ready).toBeGreaterThan(0);
    expect(call, '对账必须排在 daemon ready 之后').toBeGreaterThan(ready);
  });

  it('判为回滚时落一条 error 事件，不是只打 console', () => {
    expect(SRC).toContain("action: 'self-update.rolled-back'");
    expect(SRC).toMatch(/self-update\.rolled-back[\s\S]{0,200}severity: 'error'|severity: 'error'[\s\S]{0,200}self-update\.rolled-back/);
  });
});
