import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLiveness, recordAuditFailure } from '../../src/services/audit-liveness.js';

/**
 * E36 的回归：周期自检失败时只打 console、不落事件。
 *
 * 后果不是「少了一条日志」，而是**面板上「没跑成」和「跑了没问题」长得一模一样**。
 * 2026-08-18 那天 CDS 重启三次、每次都该自检一次，却一条事件都没有，于是几小时前
 * 的旧结论被当成当前状态用了半天，一个刚重建的容器到底收窄没有至今答不上来。
 *
 * 一个不会报错的自检比没有自检更糟——它让人以为查过了。
 */

const store = () => {
  const records: Array<Record<string, unknown>> = [];
  return { records, record: (r: Record<string, unknown>) => { records.push(r); } };
};

describe('自检活性账本', () => {
  it('跑健康过、周期内偶发一次失败：算抖动，报 warn', () => {
    const s = store();
    let now = 0;
    const liveness = new AuditLiveness(60_000, () => now);
    liveness.markSuccess();      // 前提：这项自检本来是好的
    now = 1_000;                 // 距上次成功远不到一个周期
    const snap = recordAuditFailure({
      store: s as never, liveness, source: 'infra-exposure',
      reason: '读不到容器列表', what: '基础设施暴露面自检',
    });
    expect(snap.consecutiveFailures).toBe(1);
    const ev = s.records[0];
    expect(ev.severity).toBe('warn');
    expect(String(ev.message)).toContain('读不到容器列表');
  });

  it('连着一个周期没成功就升 error，并明说「当前结论不可信」', () => {
    // 这是这条规则的核心：偶发一次和「这项自检已经哑了」不该长一个样。
    const s = store();
    let now = 0;
    const liveness = new AuditLiveness(60_000, () => now);
    liveness.markSuccess();               // 曾经成功过
    now = 61_000;                         // 超过一个完整周期
    const snap = recordAuditFailure({
      store: s as never, liveness, source: 'infra-exposure',
      reason: 'docker ps 超时', what: '基础设施暴露面自检',
    });
    expect(snap.stale).toBe(true);
    expect(s.records[0].severity).toBe('error');
    expect(String(s.records[0].message)).toContain('当前结论不可信');
  });

  it('启动以来一次都没成功过，同样算哑了', () => {
    // 「跑过又坏掉」和「一开始就没跑成」对使用者是同一件事：你看到的数据不可信。
    const s = store();
    const liveness = new AuditLiveness(60_000, () => 5_000);
    const snap = recordAuditFailure({
      store: s as never, liveness, source: 'infra-exposure',
      reason: '起步就炸', what: '基础设施暴露面自检',
    });
    expect(snap.stale).toBe(true);
    expect(snap.lastSuccessAt).toBeNull();
    expect(String(s.records[0].message)).toContain('启动以来一次都没成功过');
  });

  it('成功一次即归零，不再报哑', () => {
    let now = 0;
    const liveness = new AuditLiveness(60_000, () => now);
    liveness.markFailure();
    now = 100_000;
    expect(liveness.snapshot().stale).toBe(true);
    liveness.markSuccess();
    expect(liveness.snapshot().stale).toBe(false);
    expect(liveness.snapshot().consecutiveFailures).toBe(0);
  });
});

/**
 * 接线守卫：判据写好没人用，表现和「一切正常」一模一样——而这正是 E36 本身的形状。
 */
describe('三处周期任务都把失败接上了', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('暴露面自检的两条失败路径都落事件', () => {
    // 一条是「读不到容器列表就 return」，一条是 catch。上一版两条都只有 console。
    const audit = SRC.slice(SRC.indexOf('function startInfraExposureAudit'));
    const body = audit.slice(0, audit.indexOf('\n}\n'));
    expect(body).toContain('读不到容器列表');
    expect((body.match(/fail\(/g) || []).length, '两条失败路径都要报').toBeGreaterThanOrEqual(2);
    expect(body).toContain('liveness.markSuccess()');
  });

  it('入口自检与周期备份的整轮失败也落事件', () => {
    expect(SRC).toContain("source: 'entrypoint-check'");
    expect(SRC).toContain("source: 'infra-backup'");
    expect((SRC.match(/recordAuditFailure\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('备份的活性打点在成功/部分失败分岔之前', () => {
    // 放进 else 分支的话，长期部分失败（某个库口令不对）会被误报成「备份已经哑了」。
    // 假警报比不报更糟：真出事时没人再信它。
    const at = SRC.indexOf('backupLiveness.markSuccess()');
    const branch = SRC.indexOf("action: 'infra.backup.partial-failure'");
    expect(at).toBeGreaterThan(0);
    expect(at, '活性打点必须排在分岔之前').toBeLessThan(branch);
  });
});
