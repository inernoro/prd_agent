import { describe, expect, it } from 'vitest';
import {
  directionLabel,
  getTransferFailureMessage,
  initialManualDirection,
  isProblemRun,
  relationSummary,
  shouldConfirmAutoDirection,
  statusText,
  syncRouteText,
} from '../SyncCenterDialog';
import type { PeerSyncRun } from '@/services/real/peerSync';
import documentStorePageSource from '../DocumentStorePage.tsx?raw';
import syncCenterSource from '../SyncCenterDialog.tsx?raw';

const run = (overrides: Partial<PeerSyncRun>): PeerSyncRun => ({
  id: overrides.id ?? 'run-1',
  resourceType: 'document-store',
  itemId: 'store-1',
  itemName: '验收报告',
  direction: 'push',
  origin: 'outgoing',
  peerNodeId: 'node-1',
  peerNodeName: '正式环境',
  status: 'synced',
  created: 0,
  updated: 0,
  skipped: 0,
  deleted: 0,
  failed: 0,
  assetsRewritten: 0,
  assetRewriteFailed: 0,
  triggeredByUserId: 'user-1',
  durationMs: 0,
  startedAt: new Date().toISOString(),
  ...overrides,
});

describe('SyncCenterDialog mental model', () => {
  it('treats received as an audit record, not a user sync direction', () => {
    expect(directionLabel('received')).toBe('接收审计');
    expect(shouldConfirmAutoDirection('received')).toBe(true);
    expect(syncRouteText('received', '正式环境')).toBe('最近只是接收过对端推送，尚未确认自动同步方向');
  });

  it('keeps user-confirmed directions explicit', () => {
    expect(shouldConfirmAutoDirection('push')).toBe(false);
    expect(shouldConfirmAutoDirection('pull')).toBe(false);
    expect(shouldConfirmAutoDirection('both')).toBe(false);
    expect(syncRouteText('push', '正式环境')).toBe('自动把本库发送到「正式环境」');
    expect(syncRouteText('pull', '正式环境')).toBe('自动从「正式环境」拉回本库');
    expect(syncRouteText('both', '正式环境')).toBe('自动与「正式环境」双向保持一致');
  });

  it('uses user language for skipped and incoming records', () => {
    expect(statusText({ status: 'skipped', origin: 'outgoing', startedAt: new Date().toISOString() })).toBe('两边已一致');
    expect(statusText({ status: 'synced', origin: 'incoming', startedAt: new Date().toISOString() })).toBe('已接收对端推送');
  });

  it('keeps legacy sync management as a hidden compatibility route', () => {
    expect(documentStorePageSource).toContain("type StoreTab = 'mine' | 'team' | 'favorites' | 'likes' | 'sync'");
    expect(documentStorePageSource).toContain("const valid: StoreTab[] = ['mine', 'team', 'favorites', 'likes', 'sync']");
    expect(documentStorePageSource).toContain('<SyncManagerPanel />');
    expect(documentStorePageSource).toContain('onOpenLegacySyncPanel');
    expect(documentStorePageSource).not.toContain("key: 'sync', label");
  });

  it('keeps a single sync entry per store: send-to is a direction inside the panel, not a second facade', () => {
    // 库详情页不再有独立「发送到」按钮/弹窗——发送只是方向为 push 的同步
    expect(documentStorePageSource).not.toContain('setShowSendToPeerDetail');
    expect(documentStorePageSource).not.toContain('onOpenSend');
    // 列表页保留批量入口（多选形态），概念统一为「批量同步」
    expect(documentStorePageSource).toContain('setShowSendToPeer(true)');
    expect(documentStorePageSource).toContain('批量同步');
    // 面板内方向 = 关系设定，三选一 + 自动开关
    expect(syncCenterSource).toContain('同步方式');
    expect(syncCenterSource).toContain('自动保持同步');
    expect(syncCenterSource).toContain('内容变更时发送');
    expect(syncCenterSource).toContain('定时检查并发送');
    expect(syncCenterSource).toContain("autoMode === 'scheduled' ? 'scheduled' : 'trigger'");
  });

  it('derives the relationship direction from the last server-side sync direction', () => {
    expect(initialManualDirection('push')).toBe('push');
    expect(initialManualDirection('pull')).toBe('pull');
    expect(initialManualDirection('both')).toBe('both');
    // 强制对齐视为已确认过双向关系
    expect(initialManualDirection('align-remote')).toBe('both');
    expect(initialManualDirection('align-local')).toBe('both');
    expect(initialManualDirection('align-both')).toBe('both');
    // 只被推送过 / 从未同步 = 关系未建立，等用户选方向
    expect(initialManualDirection('received')).toBeNull();
    expect(initialManualDirection(null)).toBeNull();
    expect(initialManualDirection(undefined)).toBeNull();
  });

  it('states the relationship in one sentence for the panel header', () => {
    expect(relationSummary(null, false, '正式环境')).toBe('与「正式环境」还没有建立同步关系');
    expect(relationSummary('push', false, '正式环境')).toBe('把本库发送到「正式环境」 · 手动');
    expect(relationSummary('pull', true, '正式环境')).toBe('从「正式环境」拉回本库 · 自动');
    expect(relationSummary('both', true, '正式环境')).toBe('与「正式环境」双向保持一致 · 自动');
  });

  it('surfaces per-item transfer failures from a successful API envelope', () => {
    expect(getTransferFailureMessage({
      anyFail: true,
      results: [{ itemId: 'store-1', name: '验收报告', ok: false, message: '该知识库正在同步中，请稍后重试' }],
    })).toBe('验收报告：该知识库正在同步中，请稍后重试');
    expect(getTransferFailureMessage({ anyFail: false, results: [] })).toBeNull();
  });

  it('does not keep old failures active after a newer success for the same route', () => {
    const failed = run({ id: 'old-fail', status: 'error', startedAt: '2026-06-30T10:00:00.000Z' });
    const success = run({ id: 'new-success', status: 'synced', startedAt: '2026-06-30T10:05:00.000Z' });
    const otherDirectionFailure = run({ id: 'pull-fail', direction: 'pull', status: 'error', startedAt: '2026-06-30T10:01:00.000Z' });
    expect(isProblemRun(failed, [success, otherDirectionFailure, failed])).toBe(false);
    expect(isProblemRun(otherDirectionFailure, [success, otherDirectionFailure, failed])).toBe(true);
  });
});
