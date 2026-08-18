import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorApprovalService } from '../../src/services/operator-approval.js';
import type { IShellExecutor } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';

/**
 * 2026-05-28 SECURITY 回归:Cursor Bugbot High 反馈 — session 授权范围
 * 必须绑定到具体 args,而不是整个 op。
 *
 * 旧 bug:用户对 `shell.run dmesg|head` 点"授权 7 天" → 攻击者后续 7 天可
 * 用同一 access key 跑任意 root 命令,完全跳过 confirmText。
 *
 * 修法:sessionKey = `${callerKey}::${opId}::${argsHash}`。不同 args 必须
 * 重新批。
 */
describe('OperatorApprovalService — session args binding', () => {
  let svc: OperatorApprovalService;
  beforeEach(() => {
    svc = new OperatorApprovalService();
  });

  it('相同 args 命中 session,直接通过', async () => {
    // 第一次请求
    const r1 = await svc.submitRequest({
      opId: 'shell.run',
      args: { command: 'echo hello' },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    expect(r1.status).toBe('pending');

    // 批准 session
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'user' });

    // 同 args 第二次请求 → 自动通过(完全相同的 args 对象)
    const r2 = await svc.submitRequest({
      opId: 'shell.run',
      args: { command: 'echo hello' },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    // 注意:executeRequest 立即 fire-and-forget 异步,可能把 status 推到
    // 'completed' / 'failed'。session 命中的稳定证据是 approvedScope = 'session'
    expect(r2.approvedScope).toBe('session');
  });

  it('args 中 command 不同 → session 不命中,必须重新批', async () => {
    const r1 = await svc.submitRequest({
      opId: 'shell.run',
      args: { command: 'echo hello' },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'user' });

    // 换命令 → 不应命中
    const r2 = await svc.submitRequest({
      opId: 'shell.run',
      args: { command: 'rm -rf /' },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    expect(r2.status).toBe('pending');
    expect(r2.approvedScope).toBeUndefined();
  });

  it('args 键顺序不影响命中(canonical JSON)', async () => {
    const r1 = await svc.submitRequest({
      opId: 'shell.run',
      args: { command: 'echo hi', timeout: 5 },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'user' });

    // 同样的 args,键顺序不同 → 仍命中
    const r2 = await svc.submitRequest({
      opId: 'shell.run',
      args: { timeout: 5, command: 'echo hi' },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    expect(r2.approvedScope).toBe('session');
  });

  it('callerKey 不同 → 不命中(不同用户的授权不串)', async () => {
    const r1 = await svc.submitRequest({
      opId: 'host.stats',
      args: undefined,
      actor: 'ai',
      callerKey: 'cK_alice',
    });
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'alice' });

    const r2 = await svc.submitRequest({
      opId: 'host.stats',
      args: undefined,
      actor: 'ai',
      callerKey: 'cK_bob',
    });
    expect(r2.status).toBe('pending');
  });

  it('opId 不同 → 不命中(不同 op 的授权不串)', async () => {
    const r1 = await svc.submitRequest({
      opId: 'host.stats',
      args: undefined,
      actor: 'ai',
      callerKey: 'cK_test',
    });
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'user' });

    const r2 = await svc.submitRequest({
      opId: 'shell.run',
      args: { command: 'echo' },
      actor: 'ai',
      callerKey: 'cK_test',
    });
    expect(r2.status).toBe('pending');
  });

  it('无参数 op (host.stats) 相同 caller 走 no-args 桶,可正常命中', async () => {
    const r1 = await svc.submitRequest({
      opId: 'host.stats',
      args: undefined,
      actor: 'ai',
      callerKey: 'cK_test',
    });
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'user' });

    const r2 = await svc.submitRequest({
      opId: 'host.stats',
      args: {},   // 空对象等价 undefined
      actor: 'ai',
      callerKey: 'cK_test',
    });
    expect(r2.approvedScope).toBe('session');
  });

  it('revokeSession 撤销同 (caller, op) 下所有 argsHash 变体', async () => {
    // 批两条不同 args 的同 op
    const r1 = await svc.submitRequest({
      opId: 'shell.run', args: { command: 'a' }, actor: 'ai', callerKey: 'cK_test',
    });
    svc.approve({ requestId: r1.id, scope: 'session', approver: 'user' });
    const r2 = await svc.submitRequest({
      opId: 'shell.run', args: { command: 'b' }, actor: 'ai', callerKey: 'cK_test',
    });
    svc.approve({ requestId: r2.id, scope: 'session', approver: 'user' });

    // 撤销 → 两条都失效
    expect(svc.revokeSession('cK_test', 'shell.run')).toBe(true);

    const r3 = await svc.submitRequest({
      opId: 'shell.run', args: { command: 'a' }, actor: 'ai', callerKey: 'cK_test',
    });
    expect(r3.status).toBe('pending');
    const r4 = await svc.submitRequest({
      opId: 'shell.run', args: { command: 'b' }, actor: 'ai', callerKey: 'cK_test',
    });
    expect(r4.status).toBe('pending');
  });

  it('重启后恢复待审批请求与精确参数授权', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-operator-approval-'));
    const storagePath = path.join(dir, 'operator-approvals.json');
    const shell = {
      exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    } as unknown as IShellExecutor;
    const init = (target: OperatorApprovalService): void => target.init({
      shell,
      stateService: {} as StateService,
      repoRoot: dir,
      storagePath,
    });
    try {
      const first = new OperatorApprovalService();
      init(first);
      const pending = await first.submitRequest({
        opId: 'host.stats', actor: 'ai', callerKey: 'restart-pending',
      });
      const approved = await first.submitRequest({
        opId: 'shell.run', args: { command: 'echo stable' }, actor: 'ai', callerKey: 'restart-session',
      });
      first.approve({ requestId: approved.id, scope: 'session', approver: 'admin' });

      const second = new OperatorApprovalService();
      init(second);
      expect(second.get(pending.id)?.status).toBe('pending');
      const reused = await second.submitRequest({
        opId: 'shell.run', args: { command: 'echo stable' }, actor: 'ai', callerKey: 'restart-session',
      });
      expect(reused.approvedScope).toBe('session');
      expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
