/**
 * messageStore pending assistant 竞态条件测试
 *
 * 验证"用户发消息 → 同一帧显示 AI 思考中动画"的乐观占位实现
 * 不会产生以下两个历史 bug：
 *   Bug 1: 闪烁 — pending 消息 key 变化导致 React 重新挂载
 *   Bug 2: 重复消息 — 竞态条件下 messages 数组出现多条 assistant
 *
 * 测试策略：直接操作 Zustand store，模拟 SSE 事件到达的各种顺序
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock tauri invoke（store 导入了但 pending assistant 逻辑不调用它）
vi.mock('../../lib/tauri', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('invoke should not be called in these tests')),
}));

// 动态导入 store（在 mock 注册之后）
const { useMessageStore } = await import('../messageStore');
type Message = Parameters<ReturnType<typeof useMessageStore.getState>['startStreaming']>[0];

// ---------- helpers ----------
function makeUserMessage(id = 'user-1'): Message {
  return { id, role: 'User', content: '你好', timestamp: new Date() };
}

function makeEmptyAssistant(id = 'assistant-1'): Message {
  return { id, role: 'Assistant', content: '', timestamp: new Date() };
}

function makeFullAssistant(id = 'assistant-1', content = '你好！'): Message {
  return { id, role: 'Assistant', content, timestamp: new Date() };
}

function getState() {
  return useMessageStore.getState();
}

function resetStore() {
  getState().clearMessages();
  // 确保 pending 状态也被清掉
  useMessageStore.setState({
    pendingAssistantId: null,
    pendingUserMessageId: null,
    isStreaming: false,
    streamingMessageId: null,
    streamingPhase: null,
  });
}

// ---------- tests ----------
describe('pending assistant — 不往 messages 数组塞假消息', () => {
  beforeEach(resetStore);

  it('addUserMessageWithPendingAssistant 只添加 user 消息，不添加假 assistant', () => {
    const userMsg = makeUserMessage();
    getState().addUserMessageWithPendingAssistant({ userMessage: userMsg });

    const s = getState();
    // messages 里只有 1 条（用户消息），没有假 assistant
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('User');
    expect(s.messages[0].id).toBe('user-1');

    // pending 标志已设置
    expect(s.pendingAssistantId).toBe('__pending__');
    expect(s.pendingUserMessageId).toBe('user-1');
  });

  it('clearPendingAssistant 只清标志，不操作 messages 数组', () => {
    const userMsg = makeUserMessage();
    getState().addUserMessageWithPendingAssistant({ userMessage: userMsg });
    getState().clearPendingAssistant();

    const s = getState();
    expect(s.pendingAssistantId).toBeNull();
    // 用户消息还在
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('User');
  });
});

describe('正常流程：message → startStreaming → stopStreaming', () => {
  beforeEach(resetStore);

  it('pending → startStreaming 原子切换，无重复消息', () => {
    // 1. 用户发送消息
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });
    expect(getState().pendingAssistantId).toBe('__pending__');

    // 2. SSE 空 assistant 到达 → startStreaming
    getState().startStreaming(makeEmptyAssistant('assistant-1'));

    const s = getState();
    // pending 被清除
    expect(s.pendingAssistantId).toBeNull();
    // streaming 已启动
    expect(s.isStreaming).toBe(true);
    expect(s.streamingMessageId).toBe('assistant-1');
    // messages: 1 user + 1 assistant = 2, 不多不少
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('User');
    expect(s.messages[1].role).toBe('Assistant');
    expect(s.messages[1].id).toBe('assistant-1');
  });

  it('startStreaming 之后继续 appendToStreamingMessage 不产生额外消息', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });
    getState().startStreaming(makeEmptyAssistant('assistant-1'));
    getState().appendToStreamingMessage('你好');

    // 强制 flush（store 内部用 rAF 缓冲，测试环境直接检查 streaming 状态）
    const s = getState();
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].id).toBe('assistant-1');
  });
});

describe('Bug 1 防回归：无 key 变化（无假消息在数组中）', () => {
  beforeEach(resetStore);

  it('pending 期间 messages 里不存在 role=Assistant', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });

    const assistants = getState().messages.filter(m => m.role === 'Assistant');
    // 关键：数组里没有假 assistant，所以 React 不会渲染一个后来要被替换的节点
    expect(assistants).toHaveLength(0);
  });

  it('startStreaming 后 messages 里的 assistant ID 是真实 ID，不是 pending-xxx', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });
    getState().startStreaming(makeEmptyAssistant('real-server-id'));

    const assistants = getState().messages.filter(m => m.role === 'Assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe('real-server-id');
    // 不存在以 pending- 开头的消息
    expect(getState().messages.every(m => !m.id.startsWith('pending-'))).toBe(true);
  });
});

describe('Bug 2 防回归：竞态条件不产生重复消息', () => {
  beforeEach(resetStore);

  it('thinking 事件先于 message 事件到达：不产生重复', () => {
    // 1. 用户发送
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });

    // 2. thinking 事件先到（ChatContainer 会创建 tempMessage 然后 startStreaming）
    const tempMsg: Message = { id: 'assistant-1', role: 'Assistant', content: '', timestamp: new Date() };
    getState().startStreaming(tempMsg);
    getState().appendToStreamingThinking('让我想想...');

    // 3. message 事件后到（ChatContainer 再次 startStreaming）
    getState().startStreaming(makeEmptyAssistant('assistant-1'));

    const s = getState();
    // 依然只有 2 条消息
    expect(s.messages).toHaveLength(2);
    const assistants = s.messages.filter(m => m.role === 'Assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe('assistant-1');
    // thinking 内容被保留
    expect(assistants[0].thinking).toContain('让我想想');
  });

  it('startStreaming 被调用两次（相同 ID）：不重复追加', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });

    const assistant = makeEmptyAssistant('assistant-1');
    getState().startStreaming(assistant);
    getState().startStreaming(assistant); // 重复调用

    expect(getState().messages).toHaveLength(2);
    expect(getState().messages.filter(m => m.role === 'Assistant')).toHaveLength(1);
  });

  it('ingestGroupBroadcastMessage 收到完整 assistant 也清除 pending 标志', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });
    expect(getState().pendingAssistantId).toBe('__pending__');

    // 直接收到完整的 assistant 消息（非流式场景）
    getState().ingestGroupBroadcastMessage({
      message: makeFullAssistant('assistant-1', '这是完整回复'),
      currentUserId: null,
    });

    const s = getState();
    expect(s.pendingAssistantId).toBeNull();
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].content).toBe('这是完整回复');
  });

  it('多条 assistant 消息到达（一问多答）：每条都是独立消息，不重复', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });

    // 第一条 assistant（流式）
    getState().startStreaming(makeEmptyAssistant('assistant-1'));
    getState().appendToStreamingMessage('回复1');
    getState().stopStreaming();

    // 第二条 assistant（广播）
    getState().ingestGroupBroadcastMessage({
      message: makeFullAssistant('assistant-2', '回复2'),
      currentUserId: null,
    });

    const s = getState();
    expect(s.messages).toHaveLength(3); // 1 user + 2 assistants
    const assistants = s.messages.filter(m => m.role === 'Assistant');
    expect(assistants).toHaveLength(2);
    expect(new Set(assistants.map(a => a.id)).size).toBe(2); // ID 去重
  });
});

describe('边界场景', () => {
  beforeEach(resetStore);

  it('skipAiReply：clearPendingAssistant 不留残留', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });
    // 模拟 skipAiReply — 用户选择不要 AI 回复
    getState().clearPendingAssistant();

    const s = getState();
    expect(s.pendingAssistantId).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('User');
    // 没有 streaming 残留
    expect(s.isStreaming).toBe(false);
  });

  it('没有 pending 时 startStreaming 正常工作', () => {
    // 直接收到 streaming（例如断线重连后）
    getState().startStreaming(makeEmptyAssistant('assistant-1'));

    const s = getState();
    expect(s.isStreaming).toBe(true);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].id).toBe('assistant-1');
  });

  it('pendingAssistantId 是 "__pending__" 哨兵值，不会匹配任何真实消息 ID', () => {
    getState().addUserMessageWithPendingAssistant({ userMessage: makeUserMessage() });

    // 模拟 SSE 送来的消息 ID 永远不会是 __pending__
    const serverIds = ['abc123', '67890def', 'msg-2024-01-01'];
    for (const id of serverIds) {
      expect(id).not.toBe('__pending__');
    }

    // pendingAssistantId 不会导致 messages 里的消息被误匹配
    const matched = getState().messages.find(m => m.id === getState().pendingAssistantId);
    expect(matched).toBeUndefined();
  });
});
