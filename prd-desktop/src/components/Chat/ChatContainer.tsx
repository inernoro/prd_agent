import { memo, useEffect } from 'react';
import { invoke, listen } from '../../lib/tauri';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import WizardLoader from './WizardLoader';

const phaseText: Record<string, string> = {
  requesting: '正在请求大模型…',
  connected: '已连接，等待首包…',
  receiving: '正在接收信息…',
  typing: '开始输出…',
};

function ChatContainerInner() {
  const { sessionId, activeGroupId, currentRole } = useSessionStore();
  const messages = useMessageStore((s) => s.messages);
  const startStreaming = useMessageStore((s) => s.startStreaming);
  const appendToStreamingMessage = useMessageStore((s) => s.appendToStreamingMessage);
  const startStreamingBlock = useMessageStore((s) => s.startStreamingBlock);
  const appendToStreamingBlock = useMessageStore((s) => s.appendToStreamingBlock);
  const endStreamingBlock = useMessageStore((s) => s.endStreamingBlock);
  const setMessageCitations = useMessageStore((s) => s.setMessageCitations);
  const stopStreaming = useMessageStore((s) => s.stopStreaming);
  const setMessages = useMessageStore((s) => s.setMessages);
  const initHistoryPaging = useMessageStore((s) => s.initHistoryPaging);
  const addMessage = useMessageStore((s) => s.addMessage);
  const clearPendingAssistant = useMessageStore((s) => s.clearPendingAssistant);
  const isStreaming = useMessageStore((s) => s.isStreaming);
  const streamingMessageId = useMessageStore((s) => s.streamingMessageId);
  const streamingPhase = useMessageStore((s) => s.streamingPhase);
  const setStreamingPhase = useMessageStore((s) => s.setStreamingPhase);
  const bindSession = useMessageStore((s) => s.bindSession);

  const showTopPhaseBanner =
    isStreaming &&
    !!streamingPhase &&
    streamingPhase !== 'typing' &&
    // 如果当前已经有“流式气泡”，阶段提示应在气泡内展示，避免重复
    (!streamingMessageId || !messages?.some((m) => m.id === streamingMessageId));

  useEffect(() => {
    // 监听消息流事件
    const unlistenMessage = listen<any>('message-chunk', (event) => {
      const { type, content, messageId, errorMessage, phase, blockId, blockKind, blockLanguage, citations } = event.payload || {};
      
      if (type === 'start') {
        // 真实 start 到达：移除本地“请求中”占位气泡
        clearPendingAssistant();
        startStreaming({
          id: messageId || `assistant-${Date.now()}`,
          role: 'Assistant',
          content: '',
          timestamp: new Date(),
          viewRole: currentRole,
          blocks: [],
        });
        // 交给 store：startStreaming 默认 phase=requesting；后续 phase 事件会更新；
        // 一旦进入 typing（收到首包 delta/blockDelta），将不再被 phase 覆盖（见 messageStore.setStreamingPhase）
      } else if (type === 'blockStart' && blockId && blockKind) {
        startStreamingBlock({ id: blockId, kind: blockKind, language: blockLanguage ?? null });
      } else if (type === 'blockDelta' && blockId && content) {
        appendToStreamingBlock(blockId, content);
      } else if (type === 'blockEnd' && blockId) {
        endStreamingBlock(blockId);
      } else if (type === 'delta' && content) {
        // 兼容旧协议
        appendToStreamingMessage(content);
      } else if (type === 'citations' && messageId && Array.isArray(citations)) {
        setMessageCitations(messageId, citations);
      } else if (type === 'done') {
        clearPendingAssistant();
        stopStreaming();
      } else if (type === 'phase' && phase) {
        setStreamingPhase((phase as any) || null);
      } else if (type === 'error') {
        clearPendingAssistant();
        stopStreaming();
        if (errorMessage) {
          addMessage({
            id: `error-${Date.now()}`,
            role: 'Assistant',
            content: `请求失败：${errorMessage}`,
            timestamp: new Date(),
            viewRole: currentRole,
          });
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
  }, [currentRole, clearPendingAssistant, startStreaming, appendToStreamingMessage, startStreamingBlock, appendToStreamingBlock, endStreamingBlock, stopStreaming, addMessage, setStreamingPhase, setMessageCitations]);

  // 会话切换时加载历史消息（改用 groupId 加载群组所有消息，而非仅当前 session 消息）
  useEffect(() => {
    if (!sessionId) {
      bindSession(null);
      return;
    }

    const prevBound = useMessageStore.getState().boundSessionId;
    bindSession(sessionId);
    // 同一 session：不要重复加载/清空（包括"切到预览页再返回"的重挂载场景）
    if (prevBound === sessionId) return;

    // 必须有 groupId 才能加载群组消息历史
    if (!activeGroupId) return;

    const INITIAL_HISTORY_LIMIT = 6; // 最近 3 轮（User+Assistant）
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'whiteScreen-topLoad',hypothesisId:'H30',location:'ChatContainer.tsx:loadHistory:beforeInvoke',message:'history_initial_before_invoke',data:{groupId:String(activeGroupId||''),limit:Number(INITIAL_HISTORY_LIMIT)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    invoke<{ success: boolean; data?: Array<{ id: string; role: string; content: string; viewRole?: string; timestamp: string }>; error?: { message: string } }>(
      'get_group_message_history',
      { groupId: activeGroupId, limit: INITIAL_HISTORY_LIMIT }
    )
      .then((resp) => {
        if (resp.success && resp.data) {
          const mapped = resp.data.map((m) => ({
            id: m.id,
            role: (m.role === 'User' ? 'User' : 'Assistant') as 'User' | 'Assistant',
            content: m.content,
            timestamp: new Date(m.timestamp),
            viewRole: (m.viewRole as any) || undefined,
          }));
          setMessages(mapped);
          // 初次载入：用于"向上瀑布加载"游标初始化
          initHistoryPaging(INITIAL_HISTORY_LIMIT);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'whiteScreen-topLoad',hypothesisId:'H30',location:'ChatContainer.tsx:loadHistory:afterSet',message:'history_initial_after_set',data:{loadedLen:Array.isArray(resp.data)?resp.data.length:0},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
        }
      })
      .catch((err) => {
        console.error('Failed to load message history:', err);
      });
  }, [sessionId, activeGroupId, bindSession, setMessages, initHistoryPaging]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {showTopPhaseBanner && (
          <div className="px-4 py-2 border-b border-border bg-surface-light dark:bg-surface-dark">
            <WizardLoader label={phaseText[streamingPhase] || '处理中...'} size={86} />
          </div>
        )}
        <MessageList />
      </div>
      
      <ChatInput />
    </div>
  );
}

export default memo(ChatContainerInner);

