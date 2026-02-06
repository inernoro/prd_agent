import { useEffect, useState, useRef } from 'react';
import { invoke } from '../../lib/tauri';
import { useDefectStore } from '../../stores/defectStore';
import type { ApiResponse, DefectReport } from '../../types';

const statusLabel: Record<string, string> = {
  draft: '草稿',
  submitted: '待处理',
  assigned: '已分配',
  processing: '处理中',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭',
};

const severityLabel: Record<string, string> = {
  critical: '致命',
  major: '严重',
  minor: '一般',
  trivial: '轻微',
};

interface Props {
  defect: DefectReport;
  onClose: () => void;
}

export default function DefectDetailPanel({ defect, onClose }: Props) {
  const { defectMessages, loadDefect, loadDefectMessages, updateDefectInList } = useDefectStore();
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDefect(defect.id);
  }, [defect.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [defectMessages.length]);

  const handleSendMessage = async () => {
    if (!messageInput.trim() || sending) return;
    setSending(true);
    try {
      await invoke('send_defect_message', {
        id: defect.id,
        content: messageInput.trim(),
      });
      setMessageInput('');
      // 重新加载消息
      await loadDefectMessages(defect.id);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleAction = async (action: string) => {
    setActionLoading(true);
    try {
      let resp: ApiResponse<{ defect: DefectReport }>;
      switch (action) {
        case 'process':
          resp = await invoke('process_defect', { id: defect.id });
          break;
        case 'resolve':
          resp = await invoke('resolve_defect', { id: defect.id, resolution: '已修复' });
          break;
        case 'reject':
          resp = await invoke('reject_defect', { id: defect.id, reason: '不予修复' });
          break;
        default:
          return;
      }
      if (resp.success && resp.data) {
        const updated = (resp.data as any).defect ?? resp.data;
        updateDefectInList(updated as DefectReport);
      }
    } catch (err) {
      console.error(`Failed to ${action} defect:`, err);
    } finally {
      setActionLoading(false);
    }
  };

  const canProcess = ['submitted', 'assigned'].includes(defect.status);
  const canResolve = ['submitted', 'assigned', 'processing'].includes(defect.status);
  const canReject = ['submitted', 'assigned', 'processing'].includes(defect.status);
  const showChat = defect.status !== 'draft';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 h-[80vh] ui-glass-panel rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-text-secondary">{defect.defectNo}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10">
              {statusLabel[defect.status] || defect.status}
            </span>
            {defect.severity && (
              <span className="text-xs text-text-secondary">
                {severityLabel[defect.severity] || defect.severity}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 缺陷描述 */}
          <div>
            <h3 className="text-base font-semibold mb-2">{defect.title || '无标题'}</h3>
            <div className="text-sm text-text-secondary whitespace-pre-wrap">
              {defect.rawContent}
            </div>
          </div>

          {/* 解决/驳回信息 */}
          {defect.resolution && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <span className="text-xs font-medium text-green-600 dark:text-green-400">解决方案</span>
              <p className="text-sm mt-1">{defect.resolution}</p>
            </div>
          )}
          {defect.rejectReason && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <span className="text-xs font-medium text-red-600 dark:text-red-400">驳回原因</span>
              <p className="text-sm mt-1">{defect.rejectReason}</p>
            </div>
          )}

          {/* 操作按钮 */}
          {(canProcess || canResolve || canReject) && (
            <div className="flex gap-2 pt-2">
              {canProcess && (
                <button
                  onClick={() => handleAction('process')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
                >
                  开始处理
                </button>
              )}
              {canResolve && (
                <button
                  onClick={() => handleAction('resolve')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                >
                  标记解决
                </button>
              )}
              {canReject && (
                <button
                  onClick={() => handleAction('reject')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                >
                  驳回
                </button>
              )}
            </div>
          )}

          {/* 消息列表 */}
          {showChat && (
            <div className="border-t border-black/5 dark:border-white/10 pt-4">
              <h4 className="text-sm font-medium mb-3">讨论</h4>
              <div className="space-y-3">
                {defectMessages.map((msg) => (
                  <div key={msg.id} className={`flex gap-2 ${msg.role === 'assistant' ? '' : ''}`}>
                    <div className="w-6 h-6 rounded-full bg-primary-500/20 flex items-center justify-center text-xs shrink-0">
                      {msg.role === 'assistant' ? 'AI' : (msg.userName?.[0] || 'U')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium">{msg.userName || (msg.role === 'assistant' ? 'AI' : '用户')}</span>
                        <span className="text-xs text-text-secondary">
                          {new Date(msg.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Message input */}
        {showChat && (
          <div className="px-5 py-3 border-t border-black/5 dark:border-white/10 shrink-0">
            <div className="flex gap-2">
              <input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="输入消息..."
                className="flex-1 px-3 py-2 text-sm rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
              />
              <button
                onClick={handleSendMessage}
                disabled={sending || !messageInput.trim()}
                className="px-3 py-2 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                发送
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
