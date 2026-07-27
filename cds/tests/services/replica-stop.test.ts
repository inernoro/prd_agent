/**
 * 副本停止落状态的唯一判定（Codex 第三十五轮 P1 的完整版）。
 *
 * 第三十五轮只修了分支停止路由一处，调度器降温与 auto-lifecycle 两处照旧——
 * Codex 原话就点了名。抽成 settleMemberAfterStop 后三处共用，这里把行为钉死。
 */
import { describe, it, expect } from 'vitest';
import { settleMemberAfterStop, type StoppableReplicaMember } from '../../src/services/replica-stop.js';

const member = (over: Partial<StoppableReplicaMember> = {}): StoppableReplicaMember =>
  ({ containerName: 'cds-x-api--rs1', status: 'running', ...over });

describe('settleMemberAfterStop', () => {
  it('容器确认停了才落 stopped', async () => {
    const m = member();
    const r = await settleMemberAfterStop(m, { isRunning: async () => false, interruptedMessage: 'x' });
    expect(r).toBe('stopped');
    expect(m.status).toBe('stopped');
    expect(m.statusMessage).toBeUndefined();
  });

  it('容器仍在运行 → 落 error 并回调，绝不谎报已停止', async () => {
    const m = member();
    const seen: string[] = [];
    const r = await settleMemberAfterStop(m, {
      isRunning: async () => true,
      interruptedMessage: 'x',
      onStillRunning: (name) => seen.push(name),
    });
    expect(r).toBe('error');
    expect(m.status).toBe('error');
    expect(m.statusMessage).toContain('仍在运行');
    expect(seen).toEqual(['cds-x-api--rs1']);
  });

  it('复核查询本身失败按「仍在运行」处理（宁可报警也不静默漏掉）', async () => {
    const m = member();
    const r = await settleMemberAfterStop(m, {
      isRunning: async () => { throw new Error('docker 不可用'); },
      interruptedMessage: 'x',
    });
    expect(r).toBe('error');
  });

  it('无容器的 provisioning 成员照旧标 stopped 并写中断提示（物化栅栏按状态放弃）', async () => {
    const m = member({ containerName: undefined, status: 'provisioning' });
    const r = await settleMemberAfterStop(m, { isRunning: async () => true, interruptedMessage: '物化被降温中断' });
    expect(r).toBe('stopped');
    expect(m.status).toBe('stopped');
    expect(m.statusMessage).toBe('物化被降温中断');
  });
});
