import { memo, useEffect, useState } from 'react';
import { invoke, listen } from '../../lib/tauri';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useSystemNoticeStore } from '../../stores/systemNoticeStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import SystemNoticeOverlay from '../Feedback/SystemNoticeOverlay';
import { useGroupListStore } from '../../stores/groupListStore';
import { useGroupInfoDrawerStore } from '../../stores/groupInfoDrawerStore';
import type { DocCitation } from '../../types';
import { useGroupStreamReconnect } from '../../hooks/useGroupStreamReconnect';

// 阶段提示文案会造成重复状态块（且与“AI 回复气泡”割裂），这里不再使用。

function ChatContainerInner() {
  const { sessionId, activeGroupId, currentRole } = useSessionStore();
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  const groups = useGroupListStore((s) => s.groups);
  const openGroupDrawer = useGroupInfoDrawerStore((s) => s.open);
  const triggerScrollToBottom = useMessageStore((s) => s.triggerScrollToBottom);
  const startStreaming = useMessageStore((s) => s.startStreaming);
  const pushNotice = useSystemNoticeStore((s) => s.push);
  const bindSession = useMessageStore((s) => s.bindSession);
  const syncFromServer = useMessageStore((s) => s.syncFromServer);
  const ingestGroupBroadcastMessage = useMessageStore((s) => s.ingestGroupBroadcastMessage);
  const removeMessageById = useMessageStore((s) => s.removeMessageById);
  const localMaxSeq = useMessageStore((s) => s.localMaxSeq);
  const getLastGroupSeq = useSessionStore((s) => s.getLastGroupSeq);
  const setLastGroupSeq = useSessionStore((s) => s.setLastGroupSeq);

  // 连接状态（用于 UI 显示）
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // 旧的 message-chunk 监听器已删除：所有流式输出已统一到群组流的 delta 事件

  // 订阅群消息广播（带断线重连机制）
  const afterSeq = localMaxSeq ?? getLastGroupSeq(activeGroupId || '') ?? 0;
  const { resetHeartbeat, updateSeq } = useGroupStreamReconnect({
    groupId: activeGroupId,
    afterSeq,
    onConnectionChange: (status) => {
      setConnectionStatus(status);
      // 连接成功时清除错误信息
      if (status === 'connected') {
        setConnectionError(null);
      }
      // 只在真正断线重连时才通知（避免初始连接时的噪音）
      if (status === 'reconnecting' && connectionStatus === 'connected') {
        pushNotice('连接中断，正在重连...', { level: 'warning', ttlMs: 0, signature: 'group-stream-reconnecting' });
      } else if (status === 'connected' && connectionStatus === 'reconnecting') {
        pushNotice('连接已恢复', { level: 'info', ttlMs: 2000, signature: 'group-stream-connected' });
      }
    }
  });

  useEffect(() => {
    const unlisten = listen<any>('group-message', (event) => {
      const p = event.payload || {};
      
      // 收到任何消息（除了 error）都重置心跳
      if (p?.type && p.type !== 'error') {
        resetHeartbeat();
      }
      
      if (p?.type === 'error') {
        // 若当前已不在任何群上下文（例如刚解散/退出），忽略订阅错误提示，避免"可预期噪声"
        if (!useSessionStore.getState().activeGroupId) return;
        if (p?.errorMessage) {
          // 将错误信息显示在标题栏，而不是 Toast
          setConnectionError(String(p.errorMessage));
        }
        return;
      }
      if (p?.type === 'messageUpdated' && p?.message?.id) {
        // 用户态：软删除后应立刻从 UI 移除（不展示 tombstone）
        const m = p.message;
        if (m?.isDeleted === true || m?.IsDeleted === true) {
          removeMessageById(String(m.id));
          return; // 只有在删除时才 return
        }
        // 其他 messageUpdated 事件（如 AI 流式输出完成）继续处理
      }
      
      // 处理 blockEnd 事件：标记 block 为完成状态，可以进行 Markdown 渲染
      if (p?.type === 'blockEnd' && p?.messageId && p?.blockId) {
        const blockId = String(p.blockId);
        
        const store = useMessageStore.getState();
        store.endStreamingBlock(blockId);
        return;
      }
      
      // 处理 citations 事件：为消息添加引用/注脚信息
      if (p?.type === 'citations' && p?.messageId && Array.isArray(p?.citations)) {
        const messageId = String(p.messageId);
        const citations = p.citations as DocCitation[];
        
        useMessageStore.setState((state) => {
          const idx = state.messages.findIndex(m => m.id === messageId);
          if (idx === -1) return state;
          
          const next = [...state.messages];
          next[idx] = {
            ...next[idx],
            citations: citations
          };
          
          return { messages: next };
        });
        return;
      }
      
      // 处理 AI 流式输出的增量内容（delta）
      if (p?.type === 'delta' && p?.messageId && p?.deltaContent) {
        const messageId = String(p.messageId);
        const deltaContent = String(p.deltaContent);
        const blockId = p.blockId ? String(p.blockId) : undefined;
        const isFirstChunk = Boolean(p.isFirstChunk);
        
        
        // 如果有 blockId，使用 block 协议更新（支持 Markdown 逐块渲染）
        if (blockId) {
          const store = useMessageStore.getState();
          let targetMessage = store.messages.find(m => m.id === messageId);
          
          if (!targetMessage) {
            console.warn('[ChatContainer] Delta 事件对应的消息不存在:', messageId);
            return;
          }
          
          // 如果不是当前流式消息，先设置为流式状态
          if (store.streamingMessageId !== messageId) {
            store.startStreaming(targetMessage);
            // 重新获取消息（startStreaming 可能修改了 state）
            targetMessage = useMessageStore.getState().messages.find(m => m.id === messageId)!;
          }
          
          // 检查 block 是否已存在，如果不存在则创建（使用最新的 targetMessage）
          const blockExists = targetMessage.blocks?.some(b => b.id === blockId);
          
          if (!blockExists) {
            // 推断 block 类型（简化处理，默认为 paragraph）
            store.startStreamingBlock({ 
              id: blockId, 
              kind: 'paragraph',
              language: null 
            });
          }
          
          // 追加内容到指定 block
          store.appendToStreamingBlock(blockId, deltaContent);
          
          // 如果是第一个 chunk，标记消息为"正在输出"
          if (isFirstChunk) {
            useMessageStore.setState((state) => {
              const idx = state.messages.findIndex(m => m.id === messageId);
              if (idx === -1) return state;
              const next = [...state.messages];
              next[idx] = { ...next[idx], isStreaming: true };
              return { messages: next };
            });
          }
        } else {
          // 没有 blockId，直接更新 content（兼容旧协议）
          useMessageStore.setState((state) => {
            const targetIndex = state.messages.findIndex(m => m.id === messageId);
            
            if (targetIndex === -1) {
              console.warn('[ChatContainer] Delta 事件对应的消息不存在:', messageId);
              return state;
            }
            
            const next = [...state.messages];
            const targetMessage = next[targetIndex];
            
            const updates: any = {
              content: (targetMessage.content || '') + deltaContent
            };
            
            if (isFirstChunk) {
              updates.isStreaming = true;
            }
            
            next[targetIndex] = {
              ...targetMessage,
              ...updates
            };
            
            return { messages: next };
          });
        }
        return;
      }
      
      // 处理 message 和 messageUpdated 事件
      if ((p?.type !== 'message' && p?.type !== 'messageUpdated') || !p?.message) return;

      const m = p.message;
      const gid = String(m.groupId || '').trim();
      const seq = Number(m.groupSeq || 0);

      // 不再做"跳号补洞"：群组 seq 仅表示顺序，不保证连续可见（删除/软删会产生空洞），
      // 离线/重连一致性通过"订阅后快照校准 + 历史拉取"来保证。
      // 注意：messageUpdated 事件不依赖 seq 递增，不更新 lastGroupSeq
      if (p.type === 'message' && gid && Number.isFinite(seq) && seq > 0) {
        setLastGroupSeq(gid, seq);
        // 更新重连 hook 的 seq（用于下次断线重连）
        updateSeq(seq);
      }

      const message = {
        id: String(m.id || ''),
        role: (m.role === 'User' ? 'User' : 'Assistant') as 'User' | 'Assistant',
        content: String(m.content || ''),
        timestamp: new Date(m.timestamp || Date.now()),
        viewRole: (m.viewRole as any) || undefined,
        runId: (m as any).runId ? String((m as any).runId) : undefined,
        senderId: m.senderId ? String(m.senderId) : undefined,
        senderName: (m as any).senderName ? String((m as any).senderName) : undefined,
        senderRole: (m as any).senderRole ? ((m as any).senderRole as any) : undefined,
        senderAvatarUrl: (m as any).senderAvatarUrl ? String((m as any).senderAvatarUrl) : undefined,
        senderTags: (m as any).senderTags || undefined,
        groupSeq: Number.isFinite(seq) && seq > 0 ? seq : undefined,
        replyToMessageId: m.replyToMessageId ? String(m.replyToMessageId) : undefined,
        resendOfMessageId: m.resendOfMessageId ? String(m.resendOfMessageId) : undefined,
      };

      // 处理 messageUpdated 事件（AI 流式输出完成）
      if (p.type === 'messageUpdated') {
        const existingMessage = useMessageStore.getState().messages.find(msg => msg.id === message.id);
        const currentStreamingId = useMessageStore.getState().streamingMessageId;
        
        if (existingMessage && currentStreamingId === message.id) {
          // 延迟处理，确保所有 blockEnd 事件都已经被处理
          // 使用 setTimeout 将处理推迟到下一个事件循环
          setTimeout(() => {
            const latestMessage = useMessageStore.getState().messages.find(msg => msg.id === message.id);
            if (!latestMessage) return;
            
            // 再次检查是否有未完成的 blocks
            const hasIncompleteBlocks = latestMessage.blocks?.some(b => b.isComplete === false);
            
            if (hasIncompleteBlocks) {
              console.warn('[ChatContainer] messageUpdated 延迟检查：仍有未完成的 blocks，再次延迟');
              // 递归延迟，直到所有 blocks 完成
              setTimeout(() => {
                const finalMessage = useMessageStore.getState().messages.find(msg => msg.id === message.id);
                if (!finalMessage) return;
                
                // 最终停止流式状态（使用 stopStreaming 确保缓冲区 flush）
                const { stopStreaming } = useMessageStore.getState();
                stopStreaming();
                
                // 更新时间戳
                useMessageStore.setState((state) => {
                  const idx = state.messages.findIndex(m => m.id === message.id);
                  if (idx === -1) return state;
                  
                  const updated = [...state.messages];
                  updated[idx] = {
                    ...updated[idx],
                    timestamp: new Date(message.timestamp || Date.now()),
                  };
                  
                  return { messages: updated };
                });
              }, 50); // 再延迟 50ms
              return;
            }
            
            // 所有 blocks 都已完成，停止流式状态
            // 重要：使用 stopStreaming() 而不是直接 setState，以确保缓冲区内容被 flush
            const { stopStreaming } = useMessageStore.getState();
            stopStreaming();
            
            // 更新时间戳
            useMessageStore.setState((state) => {
              const idx = state.messages.findIndex(m => m.id === message.id);
              if (idx === -1) return state;
              
              const updated = [...state.messages];
              updated[idx] = {
                ...updated[idx],
                timestamp: new Date(message.timestamp || Date.now()),
              };
              
              return { messages: updated };
            });
          }, 100); // 延迟 100ms
        }
        return;
      }

      // 检测 AI 占位消息（空内容的 Assistant 消息）
      if (message.role === 'Assistant' && message.content === '') {
        startStreaming(message);
      } else if (message.role === 'Assistant' && message.content !== '') {
        // AI 完整消息：检查是否已存在（更新而不是新增）
        const existingMessage = useMessageStore.getState().messages.find(m => m.id === message.id);
        const currentStreamingId = useMessageStore.getState().streamingMessageId;
        
        if (existingMessage) {
          useMessageStore.getState().upsertMessage(message);
          // 直接停止流式状态（不依赖 finishStreaming 的复杂逻辑）
          if (currentStreamingId === message.id) {
            useMessageStore.setState({ 
              isStreaming: false, 
              streamingMessageId: null, 
              streamingPhase: null 
            });
          }
        } else {
          // 消息不存在，正常添加（可能是离线后重连收到的历史消息）
          ingestGroupBroadcastMessage({ currentUserId, message });
        }
      } else {
        // 用户消息
        ingestGroupBroadcastMessage({ currentUserId, message });
      }

      // 注意：AI 流式输出现在通过群组流的 delta 事件推送，不再需要单独订阅 runId 流
      // 完整的 AI 消息会在生成完成后通过 type='message' 推送
    }).catch(() => Promise.resolve((() => {}) as any));

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [currentRole, ingestGroupBroadcastMessage, currentUserId, setLastGroupSeq, getLastGroupSeq, removeMessageById, pushNotice, startStreaming, resetHeartbeat, updateSeq]);

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
      })
      .finally(() => {
        // 断线恢复（方案A）：如果最新 user 消息携带 runId 且尚未看到对应 assistant，
        // 则主动订阅该 run（避免“跳转回来后只显示一点点”）。
        const msgs = useMessageStore.getState().messages || [];
        const latestUserWithRun = [...msgs].reverse().find((m) => m.role === 'User' && m.runId);
        if (!latestUserWithRun?.runId) return;
        const hasAssistant = msgs.some((m) => m.role === 'Assistant' && m.runId === latestUserWithRun.runId);
        if (!hasAssistant) {
          invoke('subscribe_chat_run', { runId: latestUserWithRun.runId, afterSeq: 0 }).catch(() => {});
        }
      });
  }, [sessionId, activeGroupId, bindSession, syncFromServer]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">
      <SystemNoticeOverlay />
      {/* 群标题栏：右上角打开群信息侧边栏 */}
      {activeGroupId ? (
        <div className="h-12 px-4 flex items-center justify-between border-b ui-glass-bar">
          <div className="min-w-0 flex items-center gap-3">
            <button
              type="button"
              className="text-sm font-semibold text-text-primary truncate text-left hover:text-primary-600 dark:hover:text-primary-300"
              title="回到最新消息"
              onClick={() => triggerScrollToBottom()}
            >
              {groups.find((g) => g.groupId === activeGroupId)?.groupName || '群组'}
            </button>
          </div>
          <div className="flex items-center gap-3">
            {/* 错误信息（如果有） */}
            {connectionError && (
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 select-none">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span className="truncate max-w-xs">{connectionError}</span>
                <button
                  type="button"
                  onClick={() => setConnectionError(null)}
                  className="shrink-0 hover:opacity-70"
                  title="关闭"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            
            {/* 连接状态指示器（常驻） */}
            <div className="flex items-center gap-1.5 text-xs select-none shrink-0" title={
              connectionStatus === 'connected' ? '连接正常' :
              connectionStatus === 'connecting' ? '连接中...' :
              connectionStatus === 'reconnecting' ? '重连中...' :
              '未连接'
            }>
              {connectionStatus === 'connected' && (
                <>
                  <div className="w-2 h-2 rounded-full bg-green-500 dark:bg-green-400"></div>
                  <span className="text-text-tertiary">已连接</span>
                </>
              )}
              {connectionStatus === 'connecting' && (
                <>
                  <div className="w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400 animate-pulse"></div>
                  <span className="text-blue-600 dark:text-blue-400">连接中</span>
                </>
              )}
              {connectionStatus === 'reconnecting' && (
                <>
                  <svg className="w-3 h-3 text-yellow-600 dark:text-yellow-400 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span className="text-yellow-600 dark:text-yellow-400">重连中</span>
                </>
              )}
              {connectionStatus === 'disconnected' && (
                <>
                  <div className="w-2 h-2 rounded-full bg-red-500 dark:bg-red-400"></div>
                  <span className="text-red-600 dark:text-red-400">未连接</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => openGroupDrawer(activeGroupId)}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5"
              title="群信息"
              aria-label="群信息"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 12h.01M19 12h.01M5 12h.01" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <MessageList />
      </div>
      
      <ChatInput />
    </div>
  );
}

export default memo(ChatContainerInner);

