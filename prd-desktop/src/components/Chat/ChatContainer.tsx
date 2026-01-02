import { memo, useEffect } from 'react';
import { invoke, listen } from '../../lib/tauri';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useUserDirectoryStore } from '../../stores/userDirectoryStore';
import { useSystemNoticeStore } from '../../stores/systemNoticeStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import SystemNoticeOverlay from '../Feedback/SystemNoticeOverlay';

// 阶段提示文案会造成重复状态块（且与“AI 回复气泡”割裂），这里不再使用。

function ChatContainerInner() {
  const { sessionId, activeGroupId, currentRole } = useSessionStore();
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  const loadGroupMembers = useUserDirectoryStore((s) => s.loadGroupMembers);
  const startStreaming = useMessageStore((s) => s.startStreaming);
  const appendToStreamingMessage = useMessageStore((s) => s.appendToStreamingMessage);
  const startStreamingBlock = useMessageStore((s) => s.startStreamingBlock);
  const appendToStreamingBlock = useMessageStore((s) => s.appendToStreamingBlock);
  const endStreamingBlock = useMessageStore((s) => s.endStreamingBlock);
  const setMessageCitations = useMessageStore((s) => s.setMessageCitations);
  const stopStreaming = useMessageStore((s) => s.stopStreaming);
  const finishStreaming = useMessageStore((s) => s.finishStreaming);
  const clearPendingAssistant = useMessageStore((s) => s.clearPendingAssistant);
  const pushNotice = useSystemNoticeStore((s) => s.push);
  // isStreaming 状态由 MessageList/MessageBubble 负责展示（含占位动画），不再额外展示顶部 banner
  const setStreamingPhase = useMessageStore((s) => s.setStreamingPhase);
  const bindSession = useMessageStore((s) => s.bindSession);
  const syncFromServer = useMessageStore((s) => s.syncFromServer);
  const ackPendingUserMessageTimestamp = useMessageStore((s) => s.ackPendingUserMessageTimestamp);
  const ingestGroupBroadcastMessage = useMessageStore((s) => s.ingestGroupBroadcastMessage);
  const removeMessageById = useMessageStore((s) => s.removeMessageById);
  const localMaxSeq = useMessageStore((s) => s.localMaxSeq);
  const getLastGroupSeq = useSessionStore((s) => s.getLastGroupSeq);
  const setLastGroupSeq = useSessionStore((s) => s.setLastGroupSeq);

  useEffect(() => {
    // 监听消息流事件
    const unlistenMessage = listen<any>('message-chunk', (event) => {
      const {
        type,
        content,
        messageId,
        errorMessage,
        phase,
        blockId,
        blockKind,
        blockLanguage,
        citations,
        requestReceivedAtUtc,
        startAtUtc,
        firstTokenAtUtc,
        doneAtUtc,
        ttftMs,
      } = event.payload || {};

      const parseUtc = (v: any) => {
        if (typeof v !== 'string' || !v) return null;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      };
      
      if (type === 'start') {
        // 真实 start 到达：移除本地“请求中”占位气泡
        clearPendingAssistant();
        const dRecv = parseUtc(requestReceivedAtUtc);
        const dStart = parseUtc(startAtUtc) || dRecv;
        if (dRecv) {
          // 用户消息发送时间：以服务端 requestReceivedAtUtc 为准（与 DB 保持一致）
          ackPendingUserMessageTimestamp({ receivedAt: dRecv });
        }
        startStreaming({
          id: messageId || `assistant-${Date.now()}`,
          role: 'Assistant',
          content: '',
          timestamp: dStart || new Date(),
          serverRequestReceivedAtUtc: dRecv || undefined,
          serverStartAtUtc: dStart || undefined,
          viewRole: currentRole,
          blocks: [],
        });
        // 交给 store：startStreaming 默认 phase=requesting；后续 phase 事件会更新；
        // 一旦进入 typing（收到首包 delta/blockDelta），将不再被 phase 覆盖（见 messageStore.setStreamingPhase）
      } else if (type === 'blockStart' && blockId && blockKind) {
        // 首字延迟（TTFT）只在首次输出时下发一次：落到 streaming message 上
        if (messageId && (typeof ttftMs === 'number' || firstTokenAtUtc)) {
          const dFirst = parseUtc(firstTokenAtUtc);
          const dRecv = parseUtc(requestReceivedAtUtc);
          const dStart = parseUtc(startAtUtc);
          const existing = useMessageStore.getState().messages?.find((m) => m.id === messageId);
          if (existing) {
            useMessageStore.getState().upsertMessage({
              ...existing,
              ttftMs: typeof ttftMs === 'number' ? ttftMs : existing.ttftMs,
              serverFirstTokenAtUtc: dFirst || existing.serverFirstTokenAtUtc,
              serverRequestReceivedAtUtc: dRecv || existing.serverRequestReceivedAtUtc,
              serverStartAtUtc: dStart || existing.serverStartAtUtc,
              // 你的规约：assistant 时间=首字时间（与 DB 保持一致），因此首字一到就把 timestamp 回填为 firstTokenAtUtc
              timestamp: dFirst || existing.timestamp,
            } as any);
          }
        }
        startStreamingBlock({ id: blockId, kind: blockKind, language: blockLanguage ?? null });
      } else if (type === 'blockDelta' && blockId && content) {
        if (messageId && (typeof ttftMs === 'number' || firstTokenAtUtc)) {
          const dFirst = parseUtc(firstTokenAtUtc);
          const dRecv = parseUtc(requestReceivedAtUtc);
          const dStart = parseUtc(startAtUtc);
          const existing = useMessageStore.getState().messages?.find((m) => m.id === messageId);
          if (existing) {
            useMessageStore.getState().upsertMessage({
              ...existing,
              ttftMs: typeof ttftMs === 'number' ? ttftMs : existing.ttftMs,
              serverFirstTokenAtUtc: dFirst || existing.serverFirstTokenAtUtc,
              serverRequestReceivedAtUtc: dRecv || existing.serverRequestReceivedAtUtc,
              serverStartAtUtc: dStart || existing.serverStartAtUtc,
              timestamp: dFirst || existing.timestamp,
            } as any);
          }
        }
        appendToStreamingBlock(blockId, content);
      } else if (type === 'blockEnd' && blockId) {
        endStreamingBlock(blockId);
      } else if (type === 'delta' && content) {
        if (messageId && (typeof ttftMs === 'number' || firstTokenAtUtc)) {
          const dFirst = parseUtc(firstTokenAtUtc);
          const dRecv = parseUtc(requestReceivedAtUtc);
          const dStart = parseUtc(startAtUtc);
          const existing = useMessageStore.getState().messages?.find((m) => m.id === messageId);
          if (existing) {
            useMessageStore.getState().upsertMessage({
              ...existing,
              ttftMs: typeof ttftMs === 'number' ? ttftMs : existing.ttftMs,
              serverFirstTokenAtUtc: dFirst || existing.serverFirstTokenAtUtc,
              serverRequestReceivedAtUtc: dRecv || existing.serverRequestReceivedAtUtc,
              serverStartAtUtc: dStart || existing.serverStartAtUtc,
              timestamp: dFirst || existing.timestamp,
            } as any);
          }
        }
        // 兼容旧协议
        appendToStreamingMessage(content);
      } else if (type === 'citations' && messageId && Array.isArray(citations)) {
        setMessageCitations(messageId, citations);
      } else if (type === 'done') {
        // done：不再覆盖 timestamp（你的规约：assistant 落库时间=首字时间），这里只记录 doneAt 以便计算耗时
        if (messageId) {
          const dDone = parseUtc(doneAtUtc);
          const dRecv = parseUtc(requestReceivedAtUtc);
          const dStart = parseUtc(startAtUtc);
          const dFirst = parseUtc(firstTokenAtUtc);
          const existing = useMessageStore.getState().messages?.find((m) => m.id === messageId);
          if (existing && dDone) {
            const base = (dRecv || dStart || existing.serverRequestReceivedAtUtc || existing.serverStartAtUtc) ?? null;
            const totalMs = base ? Math.max(0, Math.round(dDone.getTime() - base.getTime())) : undefined;
            useMessageStore.getState().upsertMessage({
              ...existing,
              serverDoneAtUtc: dDone,
              serverFirstTokenAtUtc: dFirst || existing.serverFirstTokenAtUtc,
              serverRequestReceivedAtUtc: dRecv || existing.serverRequestReceivedAtUtc,
              serverStartAtUtc: dStart || existing.serverStartAtUtc,
              ttftMs: typeof ttftMs === 'number' ? ttftMs : existing.ttftMs,
              totalMs: totalMs ?? (existing as any).totalMs,
            } as any);
          }
        }
        clearPendingAssistant();
        finishStreaming();
      } else if (type === 'phase' && phase) {
        setStreamingPhase((phase as any) || null);
      } else if (type === 'error') {
        clearPendingAssistant();
        stopStreaming();
        if (errorMessage) {
          pushNotice(`请求失败：${errorMessage}`, { level: 'error', ttlMs: 8000, signature: `chat-error:${String(errorMessage)}` });
        }
      }
    }).catch((err) => {
      console.error('Failed to listen to message-chunk event:', err);
      return () => {};
    });

    return () => {
      unlistenMessage.then(fn => fn()).catch((err) => {
        console.error('Failed to unlisten message-chunk event:', err);
      });
    };
  }, [currentRole, clearPendingAssistant, startStreaming, appendToStreamingMessage, startStreamingBlock, appendToStreamingBlock, endStreamingBlock, stopStreaming, finishStreaming, pushNotice, setStreamingPhase, setMessageCitations]);

  // 订阅群消息广播（SSE 由 Rust 消费并 emit 为 group-message）
  // 使用 localMaxSeq 作为断点续传游标
  useEffect(() => {
    if (!activeGroupId) {
      // 退出群上下文：停止订阅，避免后台残留连接
      invoke('cancel_stream', { kind: 'group' }).catch(() => {});
      return;
    }

    // 优先使用本地 seq 边界，其次使用 sessionStore 的记录（兼容过渡）
    const afterSeq = localMaxSeq ?? getLastGroupSeq(activeGroupId) ?? 0;
    invoke('subscribe_group_messages', { groupId: activeGroupId, afterSeq }).catch(() => {});
  }, [activeGroupId, localMaxSeq, getLastGroupSeq]);

  // 首次进入群组：拉一次成员列表并缓存（用于把 senderId 显示成 username）
  useEffect(() => {
    if (!activeGroupId) return;
    loadGroupMembers(activeGroupId).catch(() => {});
  }, [activeGroupId, loadGroupMembers]);

  useEffect(() => {
    const unlisten = listen<any>('group-message', (event) => {
      const p = event.payload || {};
      if (p?.type === 'error') {
        if (p?.errorMessage) {
          pushNotice(`群消息订阅失败：${String(p.errorMessage)}`, { level: 'warning', ttlMs: 10_000, signature: `group-stream-error:${String(p.errorMessage)}` });
        }
        return;
      }
      if (p?.type === 'messageUpdated' && p?.message?.id) {
        // 用户态：软删除后应立刻从 UI 移除（不展示 tombstone）
        const m = p.message;
        if (m?.isDeleted === true || m?.IsDeleted === true) {
          removeMessageById(String(m.id));
        }
        return;
      }
      if (p?.type !== 'message' || !p?.message) return;

      const m = p.message;
      const gid = String(m.groupId || '').trim();
      const seq = Number(m.groupSeq || 0);

      // 不再做“跳号补洞”：群组 seq 仅表示顺序，不保证连续可见（删除/软删会产生空洞），
      // 离线/重连一致性通过“订阅后快照校准 + 历史拉取”来保证。
      if (gid && Number.isFinite(seq) && seq > 0) {
        setLastGroupSeq(gid, seq);
      }

      ingestGroupBroadcastMessage({
        currentUserId,
        message: {
          id: String(m.id || ''),
          role: (m.role === 'User' ? 'User' : 'Assistant'),
          content: String(m.content || ''),
          timestamp: new Date(m.timestamp || Date.now()),
          viewRole: (m.viewRole as any) || undefined,
          senderId: m.senderId ? String(m.senderId) : undefined,
          senderName: (m as any).senderName ? String((m as any).senderName) : undefined,
          senderRole: (m as any).senderRole ? ((m as any).senderRole as any) : undefined,
          groupSeq: Number.isFinite(seq) && seq > 0 ? seq : undefined,
          replyToMessageId: m.replyToMessageId ? String(m.replyToMessageId) : undefined,
          resendOfMessageId: m.resendOfMessageId ? String(m.resendOfMessageId) : undefined,
        } as any,
      });
    }).catch(() => Promise.resolve((() => {}) as any));

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [currentRole, ingestGroupBroadcastMessage, currentUserId, setLastGroupSeq, getLastGroupSeq, removeMessageById, pushNotice]);

  // 会话/群组切换时：绑定会话并执行增量同步
  // 每次进入群组都会与服务端同步（本地是线上的缓存，服务端主导）
  useEffect(() => {
    if (!sessionId) {
      bindSession(null);
      return;
    }

    // 绑定会话和群组（同一群组内切换会话不会清空消息）
    bindSession(sessionId, activeGroupId);

    // 必须有 groupId 才能执行同步
    if (!activeGroupId) return;

    // 执行增量同步：
    // - 冷启动（本地无缓存）：拉取最新 N 条
    // - 热启动（本地有缓存）：拉取 afterSeq > localMaxSeq 的增量
    const SYNC_LIMIT = 100;
    syncFromServer({ groupId: activeGroupId, limit: SYNC_LIMIT })
      .catch((err) => {
        console.error('Failed to sync messages from server:', err);
      });
  }, [sessionId, activeGroupId, bindSession, syncFromServer]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">
      <SystemNoticeOverlay />
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <MessageList />
      </div>
      
      <ChatInput />
    </div>
  );
}

export default memo(ChatContainerInner);

