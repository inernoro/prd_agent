import { describe, it, expect } from 'vitest';
import { parseBackendConversation } from '../ReprocessChatDrawer';
import type { DocumentStoreConversation } from '@/services/contracts/documentStore';

// parseBackendConversation 是「关浏览器标签页对话不丢」修复的恢复核心：
// 把后端持久化的对话解析回前端快照，并取出 mini 面板「已生成未插入」的暂存图。
// 断言：后端有内容时返回非空快照(下游会优先于 sessionStorage)；空内容回退 null；脏 JSON 不崩。

function makeConvo(over: Partial<DocumentStoreConversation>): DocumentStoreConversation {
  return {
    id: 'c1',
    userId: 'u1',
    sourceEntryId: 'e1',
    storeId: 's1',
    messagesJson: '[]',
    pendingImagesJson: '[]',
    activeRefJson: null,
    createdAt: '2026-06-03T00:00:00Z',
    updatedAt: '2026-06-03T00:00:00Z',
    ...over,
  };
}

describe('parseBackendConversation — 智能体对话后端恢复', () => {
  it('null/undefined → 空快照（下游回退 sessionStorage）', () => {
    expect(parseBackendConversation(null)).toEqual({ snapshot: null, pendingVisualUrl: null });
    expect(parseBackendConversation(undefined)).toEqual({ snapshot: null, pendingVisualUrl: null });
  });

  it('有 messages → 返回非空快照（含解析后的消息）', () => {
    const convo = makeConvo({
      messagesJson: JSON.stringify([
        { id: 'm1', role: 'user', content: '帮我配图' },
        { id: 'm2', role: 'assistant', content: '好的' },
      ]),
    });
    const { snapshot } = parseBackendConversation(convo);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.messages).toHaveLength(2);
    expect(snapshot!.messages[0].content).toBe('帮我配图');
  });

  it('只有 activeRef、无 messages → 仍返回非空快照（保留选中的智能体）', () => {
    const convo = makeConvo({
      messagesJson: '[]',
      activeRefJson: JSON.stringify({ kind: 'kbAgent', key: 'visual-agent' }),
    });
    const { snapshot } = parseBackendConversation(convo);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.activeRef).toEqual({ kind: 'kbAgent', key: 'visual-agent' });
  });

  it('空对话(无消息无 activeRef) → 快照 null（让下游回退 sessionStorage，不覆盖）', () => {
    expect(parseBackendConversation(makeConvo({})).snapshot).toBeNull();
  });

  it('pendingImagesJson 带 url → 取出暂存图 URL（连生成图也恢复）', () => {
    const convo = makeConvo({
      pendingImagesJson: JSON.stringify([{ url: 'https://x/img.png' }]),
    });
    expect(parseBackendConversation(convo).pendingVisualUrl).toBe('https://x/img.png');
  });

  it('脏 JSON 不崩，安全降级为空', () => {
    const convo = makeConvo({ messagesJson: '{bad', pendingImagesJson: 'oops', activeRefJson: 'nope' });
    const r = parseBackendConversation(convo);
    expect(r.snapshot).toBeNull();
    expect(r.pendingVisualUrl).toBeNull();
  });
});
