import { describe, expect, it } from 'vitest';
import { isSkippedResult } from '../SendToPeerDialog';
import sendToPeerSource from '../SendToPeerDialog.tsx?raw';
import type { TransferItemResult } from '@/services/real/peerSync';

describe('SendToPeerDialog', () => {
  it('shows already-synced results as skipped (已一致), not completed work', () => {
    const skipped: TransferItemResult = { itemId: 'kb-1', ok: true, created: 0, updated: 0, skipped: 112, failed: 0, message: '发送 新增0/更新0/跳过112' };
    const done: TransferItemResult = { itemId: 'kb-2', ok: true, created: 2, updated: 3 };
    const failed: TransferItemResult = { itemId: 'kb-3', ok: false, message: '目标端拒绝覆盖' };
    expect(isSkippedResult(skipped)).toBe(true);
    expect(isSkippedResult(done)).toBe(false);
    expect(isSkippedResult(failed)).toBe(false);
  });

  it('uses the topology language and drops the old monitoring-console jargon', () => {
    // 新：批量拓扑图 + 发起/历史两视图 + 停止进行中的同步
    expect(sendToPeerSource).toContain('BatchTopology');
    expect(sendToPeerSource).toContain('TONE_WIRE');
    expect(sendToPeerSource).toContain('cancelPeerSyncRun');
    expect(sendToPeerSource).toContain("useState<Tab>('send')");
    // 策略固定默认值（不再让用户开关原时间/覆盖/重传）
    expect(sendToPeerSource).toContain("mode: 'overwrite', preserveTimestamps: true, rewriteAssetLinks: true");
    // 砍掉的监听台术语与旧队列状态机
    expect(sendToPeerSource).not.toContain('监听');
    expect(sendToPeerSource).not.toContain('条目明细可审计');
    expect(sendToPeerSource).not.toContain('deriveQueueState');
    expect(sendToPeerSource).not.toContain('SyncMonitorStrip');
  });
});
