import { useEffect, useState, useRef } from 'react';
import { invoke } from '../../lib/tauri';
import { useDefectStore } from '../../stores/defectStore';
import { useAuthStore } from '../../stores/authStore';
import type { ApiResponse, DefectReport } from '../../types';

const statusLabel: Record<string, string> = {
  draft: '草稿',
  submitted: '待处理',
  assigned: '已分配',
  processing: '处理中',
  verifying: '待验收',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭',
};

const severityConfig: Record<string, { label: string; color: string }> = {
  critical: { label: '致命', color: '#ef4444' },
  major:    { label: '严重', color: '#f97316' },
  minor:    { label: '一般', color: '#eab308' },
  trivial:  { label: '轻微', color: '#22c55e' },
};

function timeAgo(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString('zh-CN');
}

interface Props {
  defect: DefectReport;
  onClose: () => void;
}

export default function DefectDetailPanel({ defect, onClose }: Props) {
  const { defectMessages, loadDefect, loadDefectMessages, updateDefectInList, loadDefects } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [resolveInput, setResolveInput] = useState('');
  const [rejectInput, setRejectInput] = useState('');
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
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
      await loadDefectMessages(defect.id);
      // 刷新缺陷详情（更新 unread 状态）
      await loadDefect(defect.id);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleAction = async (action: string, extraPayload?: Record<string, string>) => {
    setActionLoading(true);
    try {
      let resp: ApiResponse<{ defect: DefectReport }>;
      switch (action) {
        case 'process':
          resp = await invoke('process_defect', { id: defect.id });
          break;
        case 'resolve':
          resp = await invoke('resolve_defect', { id: defect.id, resolution: extraPayload?.resolution || '已修复' });
          break;
        case 'reject':
          resp = await invoke('reject_defect', { id: defect.id, reason: extraPayload?.reason || '不予修复' });
          break;
        default:
          return;
      }
      if (resp.success && resp.data) {
        const updated = (resp.data as any).defect ?? resp.data;
        updateDefectInList(updated as DefectReport);
        loadDefects();
      }
      setShowResolveDialog(false);
      setShowRejectDialog(false);
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
  const severity = severityConfig[defect.severity ?? ''] ?? severityConfig.minor;

  // 当前用户角色
  const isReporter = userId === defect.reporterId;
  const isAssignee = userId === defect.assigneeId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 h-[85vh] ui-glass-panel rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-text-secondary">{defect.defectNo}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10">
              {statusLabel[defect.status] || defect.status}
            </span>
            {defect.severity && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: severity.color + '20', color: severity.color }}>
                {severity.label}
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

          {/* 提交者 / 处理者信息 */}
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium"
                style={{ background: isReporter ? 'rgba(100,160,255,0.2)' : 'rgba(128,128,128,0.15)', color: isReporter ? 'rgba(100,160,255,1)' : 'inherit' }}>
                {(defect.reporterName ?? '?')[0]}
              </span>
              <span>提交：{defect.reporterName || '未知'}</span>
              {isReporter && <span className="text-primary-500">(我)</span>}
            </div>
            <svg className="w-3 h-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium"
                style={{ background: isAssignee ? 'rgba(120,220,180,0.2)' : 'rgba(128,128,128,0.15)', color: isAssignee ? 'rgba(120,220,180,1)' : 'inherit' }}>
                {(defect.assigneeName ?? '?')[0]}
              </span>
              <span>处理：{defect.assigneeName || '未指派'}</span>
              {isAssignee && <span className="text-green-500">(我)</span>}
            </div>
            <span className="ml-auto">{timeAgo(defect.createdAt)}</span>
          </div>

          {/* 附件 */}
          {(defect.attachments?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-text-secondary">附件 ({defect.attachments!.length})</span>
              <div className="flex flex-wrap gap-2">
                {defect.attachments!.map((att) => (
                  <a
                    key={att.id}
                    href={att.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-xs transition-colors"
                  >
                    <svg className="w-3 h-3 text-text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                    <span className="truncate max-w-[150px]">{att.fileName}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* 解决信息 */}
          {defect.resolution && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-green-600 dark:text-green-400">解决方案</span>
                <span className="text-[10px] text-text-secondary">
                  {defect.resolvedByName && `${defect.resolvedByName} · `}{timeAgo(defect.resolvedAt)}
                </span>
              </div>
              <p className="text-sm">{defect.resolution}</p>
            </div>
          )}

          {/* 驳回信息 */}
          {defect.rejectReason && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-red-600 dark:text-red-400">驳回原因</span>
                <span className="text-[10px] text-text-secondary">
                  {defect.rejectedByName && `${defect.rejectedByName}`}
                </span>
              </div>
              <p className="text-sm">{defect.rejectReason}</p>
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
                  onClick={() => setShowResolveDialog(true)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                >
                  标记解决
                </button>
              )}
              {canReject && (
                <button
                  onClick={() => setShowRejectDialog(true)}
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
              {defectMessages.length === 0 ? (
                <p className="text-xs text-text-secondary">暂无讨论消息</p>
              ) : (
                <div className="space-y-3">
                  {defectMessages.map((msg) => (
                    <div key={msg.id} className="flex gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0"
                        style={{
                          background: msg.role === 'assistant' ? 'rgba(180,140,255,0.2)' : 'rgba(100,160,255,0.2)',
                          color: msg.role === 'assistant' ? 'rgba(180,140,255,1)' : 'rgba(100,160,255,1)',
                        }}>
                        {msg.role === 'assistant' ? 'AI' : (msg.userName?.[0] || 'U')}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium">{msg.userName || (msg.role === 'assistant' ? 'AI' : '用户')}</span>
                          <span className="text-[10px] text-text-secondary">
                            {timeAgo(msg.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
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

        {/* 解决弹窗 */}
        {showResolveDialog && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 rounded-xl">
            <div className="w-80 p-4 rounded-lg ui-glass-panel shadow-lg space-y-3">
              <h4 className="text-sm font-semibold">标记为已解决</h4>
              <textarea
                value={resolveInput}
                onChange={(e) => setResolveInput(e.target.value)}
                placeholder="请输入解决方案..."
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-green-500/30 resize-none"
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowResolveDialog(false)} className="px-3 py-1.5 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">取消</button>
                <button
                  onClick={() => handleAction('resolve', { resolution: resolveInput || '已修复' })}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
                >
                  确认解决
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 驳回弹窗 */}
        {showRejectDialog && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 rounded-xl">
            <div className="w-80 p-4 rounded-lg ui-glass-panel shadow-lg space-y-3">
              <h4 className="text-sm font-semibold">驳回缺陷</h4>
              <textarea
                value={rejectInput}
                onChange={(e) => setRejectInput(e.target.value)}
                placeholder="请输入驳回原因..."
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-red-500/30 resize-none"
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowRejectDialog(false)} className="px-3 py-1.5 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">取消</button>
                <button
                  onClick={() => handleAction('reject', { reason: rejectInput || '不予修复' })}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                >
                  确认驳回
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
