import { describe, it, expect } from 'vitest';
import { parseBackendConversation, mergeChatSnapshots } from '../ReprocessChatDrawer';
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

// mergeChatSnapshots：合并后端 + sessionStorage 两源，避免切档取消去抖后端保存后、
// 重开只取到较旧后端快照而丢掉本地更新的消息（Cursor Medium F4）。
describe('mergeChatSnapshots — 后端 + sessionStorage 两源合并', () => {
  const msg = (id: string, content: string, role: 'user' | 'assistant' = 'user') =>
    ({ id, role, content }) as never;

  it('一方为空 → 返回另一方', () => {
    const s = { messages: [msg('m1', 'hi')], activeRef: undefined };
    expect(mergeChatSnapshots(null, s)).toBe(s);
    expect(mergeChatSnapshots(s, null)).toBe(s);
    expect(mergeChatSnapshots(null, null)).toBeNull();
  });

  it('sessionStorage 比后端新 → 并集补回本地更新的消息（不丢）', () => {
    const backend = { messages: [msg('m1', 'a'), msg('m2', 'b')], activeRef: undefined };
    const session = { messages: [msg('m1', 'a'), msg('m2', 'b'), msg('m3', 'c')], activeRef: undefined };
    const merged = mergeChatSnapshots(backend, session)!;
    expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('按 id + 内容去重，顺序后端在前、本地新增在后', () => {
    const backend = { messages: [msg('a1', 'x')], activeRef: undefined };
    const session = { messages: [msg('b1', 'x'), msg('b2', 'y')], activeRef: undefined }; // b1 与 a1 内容相同 → 去重
    const merged = mergeChatSnapshots(backend, session)!;
    expect(merged.messages.map((m) => m.content)).toEqual(['x', 'y']);
  });

  it('activeRef 后端优先、回退本地', () => {
    const backend = { messages: [], activeRef: { kind: 'kbAgent', key: 'be' } as never };
    const session = { messages: [], activeRef: { kind: 'kbAgent', key: 'se' } as never };
    expect(mergeChatSnapshots(backend, session)!.activeRef).toEqual({ kind: 'kbAgent', key: 'be' });
    expect(mergeChatSnapshots({ messages: [], activeRef: undefined }, session)!.activeRef)
      .toEqual({ kind: 'kbAgent', key: 'se' });
  });
});
