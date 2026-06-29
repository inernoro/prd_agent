import { describe, expect, it } from 'vitest';
import {
  pruneWebhookDeliveries,
  webhookDeliveryRetentionKey,
  WEBHOOK_DELIVERY_PER_BRANCH_MIN,
  WEBHOOK_DELIVERY_GLOBAL_MAX,
} from '../../src/services/webhook-delivery-retention.js';
import type { GithubWebhookDelivery } from '../../src/types.js';

function delivery(branchId: string, seq: number): GithubWebhookDelivery {
  return {
    id: `${branchId}-${seq}`,
    receivedAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    durationMs: 1,
    event: 'push',
    branchId,
    signatureValid: true,
    dispatchAction: 'deploy',
  };
}

function keysFor(list: GithubWebhookDelivery[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of list) {
    const k = webhookDeliveryRetentionKey(d);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

describe('pruneWebhookDeliveries', () => {
  it('keeps the recent per-branch window even when one busy branch floods the global buffer', () => {
    // 核心回归：main 安静（只有 3 条 push），busy 分支灌爆全局上限。旧的纯全局
    // ring buffer 会把 main 的 3 条全挤光（用户看到「main webhook 只有 1 条/0 条」）。
    const list: GithubWebhookDelivery[] = [];
    // main 先来 3 条（最旧）
    for (let i = 0; i < 3; i++) list.push(delivery('prd-agent-main', i));
    // busy 分支随后灌入远超全局上限的量
    for (let i = 0; i < WEBHOOK_DELIVERY_GLOBAL_MAX + 500; i++) list.push(delivery('busy-branch', i));

    const pruned = pruneWebhookDeliveries(list);

    expect(pruned.length).toBeLessThanOrEqual(WEBHOOK_DELIVERY_GLOBAL_MAX);
    // main 的 3 条必须全部留存（< per-branch 配额，永不被挤掉）
    const counts = keysFor(pruned);
    expect(counts['branch:prd-agent-main']).toBe(3);
    // busy 分支保留其最近 N 条
    expect(counts['branch:busy-branch']).toBeGreaterThanOrEqual(WEBHOOK_DELIVERY_PER_BRANCH_MIN);
    // 输出仍是时间正序
    const ids = pruned.map((d) => d.receivedAt);
    expect([...ids].sort()).toEqual(ids);
  });

  it('honours the hard global cap when active branches exceed the per-branch budget (newest survive, no branch over its window)', () => {
    // 极端过订阅：活跃分支数 × perBranchMin 远超全局上限。此时硬上限兜底（最新优先），
    // 最旧分支可能被整段淘汰，但两条不变量恒成立：总量 ≤ 全局上限、任何分支都不超配额。
    const list: GithubWebhookDelivery[] = [];
    for (let i = 0; i < WEBHOOK_DELIVERY_PER_BRANCH_MIN * 3; i++) list.push(delivery('branch-A', i));
    const branches = Math.ceil(WEBHOOK_DELIVERY_GLOBAL_MAX / WEBHOOK_DELIVERY_PER_BRANCH_MIN) + 20;
    for (let b = 0; b < branches; b++) {
      for (let i = 0; i < WEBHOOK_DELIVERY_PER_BRANCH_MIN; i++) list.push(delivery(`branch-${b}`, i));
    }
    const pruned = pruneWebhookDeliveries(list);
    expect(pruned.length).toBeLessThanOrEqual(WEBHOOK_DELIVERY_GLOBAL_MAX);
    const counts = keysFor(pruned);
    for (const k of Object.keys(counts)) {
      expect(counts[k]).toBeLessThanOrEqual(WEBHOOK_DELIVERY_PER_BRANCH_MIN);
    }
  });

  it('returns the list unchanged when under the global cap', () => {
    const list = [delivery('a', 1), delivery('b', 2), delivery('a', 3)];
    expect(pruneWebhookDeliveries(list)).toEqual(list);
  });

  it('keeps the most-recent entries within a branch (drops oldest first)', () => {
    const list: GithubWebhookDelivery[] = [];
    const total = WEBHOOK_DELIVERY_PER_BRANCH_MIN + 5;
    for (let i = 0; i < total; i++) list.push(delivery('solo', i));
    // 灌入其它分支把全局逼到上限，迫使 solo 也只能保 perBranchMin
    for (let i = 0; i < WEBHOOK_DELIVERY_GLOBAL_MAX; i++) list.push(delivery('flood', i));
    const pruned = pruneWebhookDeliveries(list);
    const solo = pruned.filter((d) => d.branchId === 'solo');
    expect(solo.length).toBe(WEBHOOK_DELIVERY_PER_BRANCH_MIN);
    // 保留的是最近的（seq 最大的）那批
    const keptSeqs = solo.map((d) => Number(d.id.split('-')[1]));
    expect(Math.min(...keptSeqs)).toBe(total - WEBHOOK_DELIVERY_PER_BRANCH_MIN);
  });

  it('groups unattributed deliveries by repo#ref, falling back to a shared bucket', () => {
    const withRepo: GithubWebhookDelivery = {
      id: 'r1', receivedAt: new Date().toISOString(), durationMs: 1, event: 'push',
      repoFullName: 'o/r', ref: 'refs/heads/x', signatureValid: false, dispatchAction: 'ignored',
    };
    const bare: GithubWebhookDelivery = {
      id: 'r2', receivedAt: new Date().toISOString(), durationMs: 1, event: 'ping',
      signatureValid: false, dispatchAction: 'ignored',
    };
    expect(webhookDeliveryRetentionKey(withRepo)).toBe('repo:o/r#refs/heads/x');
    expect(webhookDeliveryRetentionKey(bare)).toBe('unattributed');
  });
});
