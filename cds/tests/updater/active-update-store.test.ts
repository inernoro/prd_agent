/**
 * Active Update Store 集成测试 — 2026-05-07 落盘修复实测
 *
 * 用户反馈"修了七八轮还是同一个 bug",根因是 activeSelfUpdate 是 in-memory
 * 字段、process.exit 后状态消失。本次修复把状态搬到 .cds/active-update.json,
 * 但提交时只跑了 tsc + 不沾这块代码的 1227 个单测,**没真的跑通新路径**。
 *
 * 这个文件是补的"行为是否真发生"自测——按 CLAUDE.md §8.1 强制要求。
 *
 * 覆盖路径(从 sidecar/路由的角度模拟):
 *   1. markSelfUpdateActive 后文件真的落盘 + 字段含 pid + lastTickAt
 *   2. updateSelfUpdateStep 切阶段时 step + lastTickAt 同步刷新,logTail 累加
 *   3. appendSelfUpdateLog 不切 step 但累加 logTail
 *   4. tickSelfUpdate 仅刷 lastTickAt 不动 logTail(模拟 web-build 心跳)
 *   5. logTail 超过 50 条自动 ring buffer 截断
 *   6. clearSelfUpdateActive / recordSelfUpdate 自动清掉文件
 *   7. reconcileStaleOnStartup:文件存在 + pid 已死 → 标 interrupted
 *   8. reconcileStaleOnStartup:文件存在 + pid 活着 → still-running 不动
 *   9. StateService 在 repoRoot 缺失时降级 in-memory(测试兼容性)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { StateService } from '../../src/services/state.js';
import {
  readActiveUpdate,
  writeActiveUpdate,
  reconcileStaleOnStartup,
  activeUpdatePath,
  isPidAlive,
} from '../../src/updater/active-update-store.js';

describe('active-update-store + StateService 集成', () => {
  let repoRoot: string;
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-update-test-'));
    fs.mkdirSync(path.join(repoRoot, '.cds'), { recursive: true });
    stateFile = path.join(repoRoot, '.cds', 'state.json');
    service = new StateService(stateFile, repoRoot);
    service.load();
  });

  afterEach(() => {
    if (fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true });
  });

  describe('落盘 SSOT 路径', () => {
    it('markSelfUpdateActive 真的把状态写到 .cds/active-update.json', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'inernoro',
      });

      // 落盘断言 — 直接读文件,绕过 service。
      const fp = activeUpdatePath(repoRoot);
      expect(fs.existsSync(fp)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      expect(raw.actor).toBe('inernoro'); // actor 真名落盘
      expect(raw.pid).toBe(process.pid); // pid 自动填充(stale 探测要用)
      expect(typeof raw.lastTickAt).toBe('string'); // 心跳时间戳
      expect(raw.interrupted).toBe(false); // 新建状态 interrupted=false
      expect(Array.isArray(raw.logTail)).toBe(true); // logTail 初始化为空数组
    });

    it('getActiveSelfUpdate 跨"进程"读盘恢复 — 模拟 process.exit 后', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'feat/x',
        trigger: 'manual',
        actor: 'alice',
      });
      // 模拟"主进程退出 + 新进程起来"——丢掉 service,新建一个。
      const service2 = new StateService(stateFile, repoRoot);
      service2.load();
      const recovered = service2.getActiveSelfUpdate();
      expect(recovered).not.toBeNull();
      expect(recovered!.actor).toBe('alice');
      expect(recovered!.branch).toBe('feat/x');
      // 这条断言就是修复的核心 — 在改之前,service2 拿到的永远是 null。
    });

    it('updateSelfUpdateStep 同步刷 step + lastTickAt + logTail 追加', async () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'bob',
      });
      const before = readActiveUpdate(repoRoot)!;
      // 等 5ms 让 lastTickAt 能比较出差异
      await new Promise((r) => setTimeout(r, 5));
      service.updateSelfUpdateStep('validate', { logText: '[validate] 预检中' });
      const after = readActiveUpdate(repoRoot)!;
      expect(after.step).toBe('validate');
      expect(Date.parse(after.lastTickAt!)).toBeGreaterThan(Date.parse(before.lastTickAt!));
      expect(after.logTail).toHaveLength(1);
      expect(after.logTail![0].text).toContain('预检中');
      expect(after.logTail![0].level).toBe('info');
    });

    it('appendSelfUpdateLog 累加日志,不动 step', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'carol',
        step: 'web-build',
      });
      service.appendSelfUpdateLog('info', 'web build 进行中 5s');
      service.appendSelfUpdateLog('info', 'web build 进行中 10s');
      service.appendSelfUpdateLog('warning', 'pnpm 缓存温启动慢');
      const cur = readActiveUpdate(repoRoot)!;
      expect(cur.step).toBe('web-build'); // 不变
      expect(cur.logTail).toHaveLength(3);
      expect(cur.logTail![2].level).toBe('warning');
      expect(cur.logTail![2].text).toContain('pnpm');
    });

    it('logTail ring buffer:超过 50 条自动截断保留最近 50', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'd',
      });
      for (let i = 0; i < 100; i++) {
        service.appendSelfUpdateLog('info', `tick #${i}`);
      }
      const cur = readActiveUpdate(repoRoot)!;
      expect(cur.logTail).toHaveLength(50);
      expect(cur.logTail![0].text).toBe('tick #50');
      expect(cur.logTail![49].text).toBe('tick #99');
    });

    it('tickSelfUpdate 仅刷新 lastTickAt 不动 logTail', async () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'e',
      });
      service.appendSelfUpdateLog('info', '只此一条');
      const before = readActiveUpdate(repoRoot)!;
      await new Promise((r) => setTimeout(r, 5));
      service.tickSelfUpdate();
      const after = readActiveUpdate(repoRoot)!;
      expect(after.logTail).toEqual(before.logTail); // logTail 不变
      expect(Date.parse(after.lastTickAt!)).toBeGreaterThan(Date.parse(before.lastTickAt!));
    });

    it('clearSelfUpdateActive 删文件 + getActiveSelfUpdate 返 null', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'f',
      });
      expect(fs.existsSync(activeUpdatePath(repoRoot))).toBe(true);
      service.clearSelfUpdateActive();
      expect(fs.existsSync(activeUpdatePath(repoRoot))).toBe(false);
      expect(service.getActiveSelfUpdate()).toBeNull();
    });

    it('recordSelfUpdate 把当前 active 的 logTail 转储到 history.steps(用户反馈"以前的更新日志去哪了")', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'h-step',
      });
      service.updateSelfUpdateStep('validate', { logText: '[validate] 校验中' });
      service.appendSelfUpdateLog('info', 'web build 进行中 5s');
      service.appendSelfUpdateLog('warning', 'pnpm lockfile 警告');
      service.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: 'main',
        fromSha: 'abc1234',
        toSha: 'def5678',
        trigger: 'manual',
        status: 'success',
        durationMs: 12345,
        actor: 'h-step',
      });
      // 默认 slim payload(/api/self-status 默认走这条路径) — steps 被剥离
      // 换成 stepsCount,减小 payload。完整 steps 通过 includeSteps:true 拿。
      const slim = service.getSelfUpdateHistory();
      expect(slim).toHaveLength(1);
      expect(slim[0].steps).toBeUndefined();
      expect(slim[0].stepsCount).toBeGreaterThanOrEqual(3);

      const history = service.getSelfUpdateHistory(10, { includeSteps: true });
      expect(history).toHaveLength(1);
      // 关键断言:steps 字段非空,含完整 SSE 步骤序列(代替"尚未执行更新"幻觉)
      expect(Array.isArray(history[0].steps)).toBe(true);
      expect(history[0].steps!.length).toBeGreaterThanOrEqual(3);
      expect(history[0].steps!.some((s) => s.text.includes('校验中'))).toBe(true);
      expect(history[0].steps!.some((s) => s.text.includes('5s'))).toBe(true);
      expect(history[0].steps!.some((s) => s.level === 'warning')).toBe(true);
    });

    it('recordSelfUpdate 自动清 active 标记(完成 = active 必清)', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'g',
      });
      service.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: 'main',
        fromSha: 'abc1234',
        toSha: 'def5678',
        trigger: 'manual',
        status: 'success',
        durationMs: 12345,
        actor: 'g',
      });
      // active 必须清(防"幽灵进行中"幻觉)
      expect(service.getActiveSelfUpdate()).toBeNull();
      expect(fs.existsSync(activeUpdatePath(repoRoot))).toBe(false);
      // 历史记录写入(不丢)
      const history = service.getSelfUpdateHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('success');
    });
  });

  describe('reconcileStaleOnStartup 启动时清扫', () => {
    it('文件不存在 → no-file', () => {
      expect(reconcileStaleOnStartup(repoRoot)).toBe('no-file');
    });

    it('文件存在 + pid 还活着(本进程)→ still-running 不改文件', () => {
      service.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'h',
      });
      // pid 默认填的是 process.pid,本进程显然活着
      const verdict = reconcileStaleOnStartup(repoRoot);
      expect(verdict).toBe('still-running');
      const cur = readActiveUpdate(repoRoot)!;
      expect(cur.interrupted).toBe(false); // 不该被改
    });

    it('文件存在 + pid 已死(spawn 短命子进程取其 pid)→ marked-interrupted + 写错误日志', () => {
      // 起一个秒退的子进程拿 pid。退出后这个 pid 立刻 unreachable。
      const result = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' });
      const deadPid = parseInt(result.stdout.trim(), 10);
      expect(deadPid).toBeGreaterThan(0);
      // 双保险:验证 pid 真死了。pid 复用是理论隐患但短窗口内极不可能。
      expect(isPidAlive(deadPid)).toBe(false);

      writeActiveUpdate(repoRoot, {
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'sidecar',
        pid: deadPid,
        lastTickAt: new Date().toISOString(),
        logTail: [{ ts: new Date().toISOString(), level: 'info', text: 'web build 进行中 30s' }],
        interrupted: false,
      });

      const verdict = reconcileStaleOnStartup(repoRoot);
      expect(verdict).toBe('marked-interrupted');

      const cur = readActiveUpdate(repoRoot)!;
      expect(cur.interrupted).toBe(true);
      expect(cur.logTail).toHaveLength(2); // 原日志 + 新增的 [startup] 错误行
      expect(cur.logTail![1].level).toBe('error');
      expect(cur.logTail![1].text).toContain('已退出但未清理状态文件');
    });

    it('已经标过 interrupted 的不再二次处理(幂等)', () => {
      writeActiveUpdate(repoRoot, {
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'sidecar',
        pid: 1, // root pid 通常存在,但已被 interrupted=true 短路保护
        lastTickAt: new Date().toISOString(),
        interrupted: true,
        logTail: [],
      });
      expect(reconcileStaleOnStartup(repoRoot)).toBe('marked-interrupted');
    });
  });

  describe('GitHub Webhook 投递日志(2026-05-07)', () => {
    it('recordGithubWebhookDelivery 写入 + getGithubWebhookDeliveries 倒序读取', () => {
      service.recordGithubWebhookDelivery({
        id: 'd1', receivedAt: '2026-05-07T10:00:00Z', durationMs: 100,
        deliveryId: 'gh-d1', event: 'push', repoFullName: 'owner/repo',
        commitSha: 'abc1234', actor: 'alice',
        signatureValid: true, dispatchAction: 'deploy', dispatchReason: 'deploy main',
      });
      service.recordGithubWebhookDelivery({
        id: 'd2', receivedAt: '2026-05-07T10:00:01Z', durationMs: 50,
        event: 'push', signatureValid: true, dispatchAction: 'skipped', dispatchReason: 'no-op',
      });
      const list = service.getGithubWebhookDeliveries();
      expect(list).toHaveLength(2);
      // 倒序:最新在前
      expect(list[0].id).toBe('d2');
      expect(list[1].id).toBe('d1');
      expect(list[1].repoFullName).toBe('owner/repo');
      expect(list[1].dispatchAction).toBe('deploy');
    });

    it('ring buffer 上限 1000,超过自动丢最早', () => {
      // 2026-05-14: 上限从 200 提升到 1000（webhook 日志可回溯窗口扩大）。
      for (let i = 0; i < 1050; i++) {
        service.recordGithubWebhookDelivery({
          id: `d${i}`, receivedAt: new Date(Date.parse('2026-05-07T10:00:00Z') + i * 1000).toISOString(),
          durationMs: 10, event: 'push', signatureValid: true,
          dispatchAction: 'deploy', dispatchReason: `${i}`,
        });
      }
      const list = service.getGithubWebhookDeliveries(2000);
      expect(list).toHaveLength(1000);
      // 最早保留的应该是 d50(0..49 已被挤掉,共推 1050 条)
      expect(list[list.length - 1].id).toBe('d50');
      expect(list[0].id).toBe('d1049');
    });

    it('limit 参数限制返回数量,默认 50', () => {
      for (let i = 0; i < 30; i++) {
        service.recordGithubWebhookDelivery({
          id: `d${i}`, receivedAt: new Date().toISOString(), durationMs: 10,
          event: 'push', signatureValid: true, dispatchAction: 'deploy',
        });
      }
      expect(service.getGithubWebhookDeliveries()).toHaveLength(30); // 实际只有 30 条,默认 50 不限制
      expect(service.getGithubWebhookDeliveries(10)).toHaveLength(10);
      expect(service.getGithubWebhookDeliveries(1)).toHaveLength(1);
    });
  });

  describe('降级路径(repoRoot 缺失时 in-memory 兜底)', () => {
    it('StateService 不带 repoRoot → activeSelfUpdate 走内存,不写盘', () => {
      const memOnly = new StateService(stateFile);
      memOnly.load();
      memOnly.markSelfUpdateActive({
        startedAt: new Date().toISOString(),
        branch: 'main',
        trigger: 'manual',
        actor: 'test',
      });
      expect(memOnly.getActiveSelfUpdate()?.actor).toBe('test');
      // .cds/active-update.json 不应该存在 — 没 repoRoot 没法决定写哪
      expect(fs.existsSync(activeUpdatePath(repoRoot))).toBe(false);
    });
  });
});
