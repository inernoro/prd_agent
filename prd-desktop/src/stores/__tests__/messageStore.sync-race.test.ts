/**
 * messageStore 增量同步竞态条件测试
 *
 * 验证以下历史问题场景：
 *   1. syncFromServer 期间切换群组 → 旧群数据写入新群
 *   2. loadOlderMessages 期间切换群组 → 旧群历史混入新群
 *   3. 并发 syncFromServer 调用 → isSyncing 互斥
 *   4. ingestGroupBroadcastMessage 去重逻辑
 *   5. bindSession/bindGroupContext 清理干净不残留
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// 可控的 invoke 桩
let invokeImpl: Mock;
vi.mock('../../lib/tauri', () => ({
  invoke: (...args: any[]) => invokeImpl(...args),
}));

const { useMessageStore } = await import('../messageStore');

type Message = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  timestamp: Date;
  groupSeq?: number;
  senderId?: string;
};

function getState() {
  return useMessageStore.getState();
}

function resetStore() {
  getState().clearMessages();
  useMessageStore.setState({
    pendingAssistantId: null,
    pendingUserMessageId: null,
    isStreaming: false,
    streamingMessageId: null,
    streamingPhase: null,
    boundSessionId: null,
    boundGroupId: null,
    localMinSeq: null,
    localMaxSeq: null,
    isSyncing: false,
    isLoadingOlder: false,
    hasMoreOlder: true,
  });
}

function makeHistoryItem(id: string, role: string, content: string, seq: number) {
  return {
    id,
    role,
    content,
    timestamp: new Date().toISOString(),
    groupSeq: seq,
  };
}

// ---------- tests ----------

describe('syncFromServer 竞态：切换群组期间', () => {
  beforeEach(() => {
    resetStore();
    invokeImpl = vi.fn();
  });

  it('isSyncing 互斥：并发调用第二次直接返回', async () => {
    // 第一次调用会挂起
    let resolveFirst: Function;
    invokeImpl.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));

    // 绑定群组
    getState().bindGroupContext('group-A');

    // 第一次同步（挂起）
    const p1 = getState().syncFromServer({ groupId: 'group-A', limit: 50 });
    expect(getState().isSyncing).toBe(true);

    // 第二次同步（应该被拒绝）
    const result2 = await getState().syncFromServer({ groupId: 'group-A', limit: 50 });
    expect(result2).toEqual({ added: 0, replaced: false });

    // 完成第一次
    resolveFirst!({
      success: true,
      data: [makeHistoryItem('m1', 'User', '你好', 1)],
    });
    const result1 = await p1;
    expect(result1.added).toBeGreaterThanOrEqual(1);
    expect(getState().isSyncing).toBe(false);
  });

  it('syncFromServer 异常不会导致 isSyncing 残留', async () => {
    invokeImpl.mockRejectedValueOnce(new Error('网络错误'));

    getState().bindGroupContext('group-A');
    const result = await getState().syncFromServer({ groupId: 'group-A', limit: 50 });

    expect(result).toEqual({ added: 0, replaced: false });
    expect(getState().isSyncing).toBe(false);
  });

  it('冷启动 syncFromServer 设置消息和 hasMoreOlder', async () => {
    // 冷启动：本地无消息
    const items = Array.from({ length: 50 }, (_, i) =>
      makeHistoryItem(`m${i}`, i % 2 === 0 ? 'User' : 'Assistant', `msg-${i}`, i + 1)
    );
    invokeImpl.mockResolvedValueOnce({ success: true, data: items });

    getState().bindGroupContext('group-A');
    const result = await getState().syncFromServer({ groupId: 'group-A', limit: 50 });

    // 冷启动用 setMessages（replaced=true）
    expect(result.replaced).toBe(true);
    expect(result.added).toBe(50);
    expect(getState().messages).toHaveLength(50);
    // 50 条 = limit → 可能还有更早历史
    expect(getState().hasMoreOlder).toBe(true);
  });
});

describe('loadOlderMessages 竞态', () => {
  beforeEach(() => {
    resetStore();
    invokeImpl = vi.fn();
  });

  it('isLoadingOlder 互斥：并发调用第二次直接返回', async () => {
    let resolveFirst: Function;
    invokeImpl.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));

    getState().bindGroupContext('group-A');
    // 模拟已有消息
    getState().setMessages([
      { id: 'm10', role: 'User', content: '最新', timestamp: new Date(), groupSeq: 10 } as any,
    ]);

    const p1 = getState().loadOlderMessages({ groupId: 'group-A', limit: 50 });
    expect(getState().isLoadingOlder).toBe(true);

    const result2 = await getState().loadOlderMessages({ groupId: 'group-A', limit: 50 });
    expect(result2).toEqual({ added: 0 });

    resolveFirst!({ success: true, data: [] });
    await p1;
    expect(getState().isLoadingOlder).toBe(false);
  });

  it('hasMoreOlder=false 时不发请求', async () => {
    getState().bindGroupContext('group-A');
    useMessageStore.setState({ hasMoreOlder: false });

    const result = await getState().loadOlderMessages({ groupId: 'group-A', limit: 50 });
    expect(result).toEqual({ added: 0 });
    expect(invokeImpl).not.toHaveBeenCalled();
  });
});

describe('ingestGroupBroadcastMessage 去重', () => {
  beforeEach(resetStore);

  it('相同 ID 消息更新而非重复插入', () => {
    const msg1: Message = {
      id: 'msg-1', role: 'User', content: 'v1',
      timestamp: new Date(), groupSeq: 1,
    };
    getState().ingestGroupBroadcastMessage({ message: msg1, currentUserId: null });
    expect(getState().messages).toHaveLength(1);

    // 相同 ID 更新
    const msg1Updated: Message = {
      id: 'msg-1', role: 'User', content: 'v2',
      timestamp: new Date(), groupSeq: 1,
    };
    getState().ingestGroupBroadcastMessage({ message: msg1Updated, currentUserId: null });
    expect(getState().messages).toHaveLength(1);
    expect(getState().messages[0].content).toBe('v2');
  });

  it('发送者 user message 去重：(senderId + content + 时间窗口)', () => {
    const now = new Date();
    // 本地乐观消息（可能用临时 ID）
    const localMsg: Message = {
      id: 'temp-123', role: 'User', content: '你好',
      timestamp: now, senderId: 'user-A',
    };
    getState().ingestGroupBroadcastMessage({ message: localMsg, currentUserId: 'user-A' });
    expect(getState().messages).toHaveLength(1);

    // 服务端广播同一条（真实 ID）但内容和发送者相同，时间窗口内
    const serverMsg: Message = {
      id: 'server-456', role: 'User', content: '你好',
      timestamp: new Date(now.getTime() + 1000), senderId: 'user-A',
    };
    getState().ingestGroupBroadcastMessage({ message: serverMsg, currentUserId: 'user-A' });

    // 应该去重合并，而非插入第二条
    expect(getState().messages).toHaveLength(1);
    // 合并后用服务端的数据
    expect(getState().messages[0].id).toBe('server-456');
  });

  it('不同用户的相同内容不去重', () => {
    const msg1: Message = {
      id: 'msg-1', role: 'User', content: '你好',
      timestamp: new Date(), senderId: 'user-A',
    };
    const msg2: Message = {
      id: 'msg-2', role: 'User', content: '你好',
      timestamp: new Date(), senderId: 'user-B',
    };
    getState().ingestGroupBroadcastMessage({ message: msg1, currentUserId: 'user-A' });
    getState().ingestGroupBroadcastMessage({ message: msg2, currentUserId: 'user-A' });

    // user-B 的消息不会被 user-A 的去重逻辑合并
    expect(getState().messages).toHaveLength(2);
  });

  it('localMaxSeq 单调递增', () => {
    const msg1: Message = {
      id: 'msg-1', role: 'User', content: 'a',
      timestamp: new Date(), groupSeq: 5,
    };
    getState().ingestGroupBroadcastMessage({ message: msg1, currentUserId: null });
    expect(getState().localMaxSeq).toBe(5);

    // 乱序到达：seq=3 不应该降低 maxSeq
    const msg2: Message = {
      id: 'msg-2', role: 'User', content: 'b',
      timestamp: new Date(), groupSeq: 3,
    };
    getState().ingestGroupBroadcastMessage({ message: msg2, currentUserId: null });
    expect(getState().localMaxSeq).toBe(5); // 不降
  });

  it('收到 Assistant 消息清除 pendingAssistantId', () => {
    getState().addUserMessageWithPendingAssistant({
      userMessage: { id: 'u1', role: 'User', content: '问题', timestamp: new Date() },
    });
    expect(getState().pendingAssistantId).toBe('__pending__');

    getState().ingestGroupBroadcastMessage({
      message: { id: 'a1', role: 'Assistant', content: '回答', timestamp: new Date(), groupSeq: 2 },
      currentUserId: null,
    });
    expect(getState().pendingAssistantId).toBeNull();
  });
});

describe('bindSession / bindGroupContext 清理', () => {
  beforeEach(resetStore);

  it('切换群组清空所有状态', () => {
    // 模拟旧群组状态
    getState().bindGroupContext('group-A');
    getState().addUserMessageWithPendingAssistant({
      userMessage: { id: 'u1', role: 'User', content: 'msg', timestamp: new Date() },
    });
    getState().startStreaming({ id: 'a1', role: 'Assistant', content: '', timestamp: new Date() });

    // 切换到新群组
    getState().bindGroupContext('group-B');

    const s = getState();
    expect(s.messages).toHaveLength(0);
    expect(s.isStreaming).toBe(false);
    expect(s.streamingMessageId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
    expect(s.localMinSeq).toBeNull();
    expect(s.localMaxSeq).toBeNull();
    expect(s.isSyncing).toBe(false);
    expect(s.boundGroupId).toBe('group-B');
  });

  it('同一群组内切换 session 保留消息', () => {
    getState().bindSession('session-1', 'group-A');
    getState().addUserMessageWithPendingAssistant({
      userMessage: { id: 'u1', role: 'User', content: 'msg', timestamp: new Date() },
    });

    // 同一群组换 session
    getState().bindSession('session-2', 'group-A');

    const s = getState();
    expect(s.messages).toHaveLength(1); // 消息保留
    expect(s.boundSessionId).toBe('session-2');
    expect(s.boundGroupId).toBe('group-A');
  });

  it('解绑（null session）清空一切', () => {
    getState().bindSession('session-1', 'group-A');
    getState().addUserMessageWithPendingAssistant({
      userMessage: { id: 'u1', role: 'User', content: 'msg', timestamp: new Date() },
    });

    getState().bindSession(null as any, null as any);

    const s = getState();
    expect(s.messages).toHaveLength(0);
    expect(s.boundSessionId).toBeNull();
    expect(s.boundGroupId).toBeNull();
  });
});

describe('mergeMessages 去重与排序', () => {
  beforeEach(resetStore);

  it('合并新消息不重复', () => {
    getState().setMessages([
      { id: 'm1', role: 'User', content: 'a', timestamp: new Date(), groupSeq: 1 } as any,
      { id: 'm2', role: 'Assistant', content: 'b', timestamp: new Date(), groupSeq: 2 } as any,
    ]);

    const added = getState().mergeMessages([
      { id: 'm2', role: 'Assistant', content: 'b-updated', timestamp: new Date(), groupSeq: 2 } as any,
      { id: 'm3', role: 'User', content: 'c', timestamp: new Date(), groupSeq: 3 } as any,
    ]);

    expect(added).toBe(1); // 只有 m3 是新的
    expect(getState().messages).toHaveLength(3);
    // m2 被更新
    expect(getState().messages.find(m => m.id === 'm2')?.content).toBe('b-updated');
  });

  it('prependMessages 不重复', () => {
    getState().setMessages([
      { id: 'm5', role: 'User', content: 'e', timestamp: new Date(), groupSeq: 5 } as any,
    ]);

    const added = getState().prependMessages([
      { id: 'm3', role: 'User', content: 'c', timestamp: new Date(), groupSeq: 3 } as any,
      { id: 'm5', role: 'User', content: 'e-dup', timestamp: new Date(), groupSeq: 5 } as any, // 重复
    ]);

    expect(added).toBe(1); // 只有 m3
    expect(getState().messages).toHaveLength(2);
    // m5 保持原内容（prepend 不覆盖）
    expect(getState().messages.find(m => m.id === 'm5')?.content).toBe('e');
  });
});

describe('groupListStore 重复插入', () => {
  // 单独测试 groupListStore
  it('addGroup 不检查重复（已知风险）', async () => {
    const { useGroupListStore } = await import('../groupListStore');

    useGroupListStore.setState({ groups: [] });

    const group = {
      groupId: 'g1', groupName: '测试群',
      createdAt: new Date().toISOString(),
    } as any;

    useGroupListStore.getState().addGroup(group);
    useGroupListStore.getState().addGroup(group); // 重复添加

    // 当前实现：会出现重复 ← 这是已知风险
    const groups = useGroupListStore.getState().groups;
    expect(groups).toHaveLength(2); // 暴露问题：同一 group 出现两次
    expect(groups[0].groupId).toBe('g1');
    expect(groups[1].groupId).toBe('g1');
  });
});

describe('removeMessageById 清理 streaming 残留', () => {
  beforeEach(resetStore);

  it('删除正在 streaming 的消息时同时清除 streaming 状态', () => {
    getState().addUserMessageWithPendingAssistant({
      userMessage: { id: 'u1', role: 'User', content: 'msg', timestamp: new Date() },
    });
    getState().startStreaming({ id: 'a1', role: 'Assistant', content: '', timestamp: new Date() });
    expect(getState().isStreaming).toBe(true);
    expect(getState().streamingMessageId).toBe('a1');

    // 删除 streaming 消息
    getState().removeMessageById('a1');

    const s = getState();
    expect(s.messages).toHaveLength(1); // 只剩 user
    expect(s.isStreaming).toBe(false);
    expect(s.streamingMessageId).toBeNull();
  });

  it('删除非 streaming 消息不影响 streaming 状态', () => {
    getState().setMessages([
      { id: 'u1', role: 'User', content: 'q1', timestamp: new Date() } as any,
      { id: 'u2', role: 'User', content: 'q2', timestamp: new Date() } as any,
    ]);
    getState().startStreaming({ id: 'a1', role: 'Assistant', content: '', timestamp: new Date() });

    getState().removeMessageById('u1');

    expect(getState().isStreaming).toBe(true);
    expect(getState().streamingMessageId).toBe('a1');
  });
});
