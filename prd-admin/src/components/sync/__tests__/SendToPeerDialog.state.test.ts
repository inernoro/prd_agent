import { describe, expect, it } from 'vitest';
import { deriveQueueState } from '../SendToPeerDialog';
import type { SyncItemSummary, TransferItemResult } from '@/services/real/peerSync';

const selectedItems: SyncItemSummary[] = [
  { itemId: 'kb-1', name: '时间回写验收-202606130838', recordCount: 1 },
  { itemId: 'kb-2', name: '状态面板验收-202606130818', recordCount: 1 },
  { itemId: 'kb-3', name: '验收报告', recordCount: 99 },
  { itemId: 'kb-4', name: '图片重传验收-202606130625', recordCount: 1 },
];

describe('SendToPeerDialog queue state', () => {
  it('keeps summary buckets balanced while a transfer is running', () => {
    const state = deriveQueueState(selectedItems, true, {
      step: 3,
      stage: '正在按血缘合并内容',
      startedAt: Date.now(),
    }, null, null);

    expect(state.selectedCount).toBe(4);
    expect(state.doneCount + state.runningCount + state.waitingCount + state.failedCount).toBe(state.selectedCount);
    expect(state.runningCount).toBe(1);
    expect(state.waitingCount).toBe(3);
  });

  it('does not report reverse verification before the readback step', () => {
    const merging = deriveQueueState(selectedItems, true, {
      step: 3,
      stage: '正在按血缘合并内容',
      startedAt: Date.now(),
    }, null, null);
    const readingBack = deriveQueueState(selectedItems, true, {
      step: 4,
      stage: '正在回写同步状态',
      startedAt: Date.now(),
    }, null, null);

    expect(merging.reverseLabel).toBe('等待回读');
    expect(readingBack.reverseLabel).toBe('正在回读同步结果');
  });

  it('keeps the frozen transfer item running even if the live selection changes', () => {
    const frozenQueue = selectedItems.slice(0, 2);
    const state = deriveQueueState(frozenQueue, true, {
      step: 4,
      stage: '正在回写同步状态',
      startedAt: Date.now(),
    }, null, null);

    expect(state.selectedCount).toBe(2);
    expect(state.activeItem?.itemId).toBe('kb-1');
    expect(state.itemStates.get('kb-1')).toBe('running');
    expect(state.itemProgress.get('kb-1')).toBeGreaterThan(0);
    expect(state.itemStates.get('kb-2')).toBe('waiting');
  });

  it('derives completed and failed counts from transfer results', () => {
    const results: TransferItemResult[] = [
      { itemId: 'kb-1', ok: true },
      { itemId: 'kb-2', ok: false, message: '目标端拒绝覆盖' },
      { itemId: 'kb-3', ok: true },
      { itemId: 'kb-4', ok: true },
    ];
    const state = deriveQueueState(selectedItems, false, null, results, null);

    expect(state.doneCount).toBe(3);
    expect(state.failedCount).toBe(1);
    expect(state.waitingCount).toBe(0);
    expect(state.doneCount + state.runningCount + state.waitingCount + state.failedCount).toBe(state.selectedCount);
    expect(state.reverseLabel).toBe('部分条目未通过');
  });
});
