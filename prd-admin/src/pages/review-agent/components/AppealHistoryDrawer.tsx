import { useState, useEffect, useCallback } from 'react';
import { MobileDrawer } from '@/components/ui/MobileDrawer';
import { listAppeals, approveAppeal, rejectAppeal } from '@/services/real/reviewAgent';
import type { ReviewAppeal } from '@/services/real/reviewAgent';
import { CheckCircle, XCircle, Clock, X, History } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  submissionId: string;
  /** 当前用户是否持有 ReviewAgentAppealReview 权限 */
  canResolve: boolean;
  /** 受理后回调（父组件应据此刷新 submission 状态） */
  onChange?: () => void;
}

export function AppealHistoryDrawer({ open, onClose, submissionId, canResolve, onChange }: Props) {
  const [appeals, setAppeals] = useState<ReviewAppeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{ appealId: string; action: 'approve' | 'reject' } | null>(null);
  const [comment, setComment] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listAppeals(submissionId);
    if (res.success && res.data) {
      setAppeals(res.data.items);
    }
    setLoading(false);
  }, [submissionId]);

  useEffect(() => {
    if (open) {
      setConfirmAction(null);
      setComment('');
      setError(null);
      load();
    }
  }, [open, load]);

  const handleResolve = async () => {
    if (!confirmAction) return;
    if (comment.trim().length < 5) {
      setError('受理意见至少 5 个字');
      return;
    }
    setResolving(true);
    setError(null);
    const fn = confirmAction.action === 'approve' ? approveAppeal : rejectAppeal;
    const res = await fn(confirmAction.appealId, { comment: comment.trim() });
    setResolving(false);
    if (!res.success) {
      setError(res.error?.message || '受理失败');
      return;
    }
    setConfirmAction(null);
    setComment('');
    await load();
    onChange?.();
  };

  return (
    <MobileDrawer open={open} onOpenChange={(v) => { if (!v) onClose(); }} side="right" width={520}>
      <div className="h-full flex flex-col bg-[#15171b]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
              <History className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">申诉历史</h3>
              <p className="text-[11px] text-white/40 mt-0.5">{appeals.length} 条记录</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4" style={{ overscrollBehavior: 'contain' }}>
          {loading ? (
            <div className="text-center text-sm text-white/40 py-10">加载中...</div>
          ) : appeals.length === 0 ? (
            <div className="text-center text-sm text-white/40 py-10">暂无申诉记录</div>
          ) : (
            <div className="space-y-3">
              {appeals.map(a => (
                <AppealCard
                  key={a.id}
                  appeal={a}
                  canResolve={canResolve && !confirmAction}
                  onApprove={() => { setConfirmAction({ appealId: a.id, action: 'approve' }); setError(null); }}
                  onReject={() => { setConfirmAction({ appealId: a.id, action: 'reject' }); setError(null); }}
                />
              ))}
            </div>
          )}
        </div>

        {/* 受理表单 */}
        {confirmAction && (
          <div className="border-t border-white/10 p-4 bg-white/[0.02]">
            <div className="text-sm text-white mb-2">
              {confirmAction.action === 'approve' ? '通过申诉' : '驳回申诉'}
              <span className="text-xs text-white/40 ml-2">请填写受理意见（≥5 字）</span>
            </div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={confirmAction.action === 'approve' ? '说明通过的理由，便于提交人理解...' : '说明驳回的理由，帮助提交人改进...'}
              className="w-full min-h-[80px] p-2.5 rounded-lg border border-white/10 bg-white/5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-indigo-500/50"
              disabled={resolving}
            />
            {error && <div className="text-xs text-red-400/90 mt-1.5">{error}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => { setConfirmAction(null); setComment(''); setError(null); }}
                disabled={resolving}
                className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-colors"
              >取消</button>
              <button
                onClick={handleResolve}
                disabled={resolving || comment.trim().length < 5}
                className={`text-xs px-3 py-1.5 rounded-lg text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  confirmAction.action === 'approve'
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-rose-600 hover:bg-rose-500'
                }`}
              >{resolving ? '提交中...' : confirmAction.action === 'approve' ? '确认通过' : '确认驳回'}</button>
            </div>
          </div>
        )}
      </div>
    </MobileDrawer>
  );
}

function AppealCard({
  appeal,
  canResolve,
  onApprove,
  onReject,
}: {
  appeal: ReviewAppeal;
  canResolve: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const statusInfo = appeal.status === 'Approved'
    ? { label: '已通过', cls: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30', icon: <CheckCircle className="w-3 h-3" /> }
    : appeal.status === 'Rejected'
      ? { label: '已驳回', cls: 'text-rose-400 bg-rose-500/15 border-rose-500/30', icon: <XCircle className="w-3 h-3" /> }
      : { label: '审理中', cls: 'text-blue-400 bg-blue-500/15 border-blue-500/30', icon: <Clock className="w-3 h-3" /> };

  return (
    <div className="bg-white/3 border border-white/8 rounded-lg p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${statusInfo.cls}`}>
          {statusInfo.icon}
          {statusInfo.label}
        </div>
        <div className="text-[11px] text-white/40">{new Date(appeal.createdAt).toLocaleString('zh-CN')}</div>
      </div>

      <div className="text-[11px] text-white/40 mb-1">{appeal.submitterName} 的申诉理由：</div>
      <div
        className="appeal-content text-sm text-white/85 bg-white/[0.02] border border-white/5 rounded-md p-2.5 mb-2 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: appeal.reasonHtml }}
      />

      {appeal.status !== 'Pending' && (
        <>
          <div className="text-[11px] text-white/40 mb-1 mt-2">{appeal.resolverName ?? '管理员'} 的受理意见：</div>
          <div className="text-sm text-white/80 bg-white/[0.02] border border-white/5 rounded-md p-2.5 whitespace-pre-wrap">
            {appeal.resolverComment ?? '—'}
          </div>
          {appeal.resolvedAt && (
            <div className="text-[11px] text-white/30 mt-1">{new Date(appeal.resolvedAt).toLocaleString('zh-CN')}</div>
          )}
        </>
      )}

      {appeal.status === 'Pending' && canResolve && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-white/5">
          <button
            onClick={onApprove}
            className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 transition-colors"
          >通过</button>
          <button
            onClick={onReject}
            className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 transition-colors"
          >驳回</button>
        </div>
      )}

      <style>{`
        .appeal-content img {
          max-width: 100%;
          border-radius: 4px;
          margin: 4px 0;
        }
        .appeal-content p {
          margin: 0 0 6px;
        }
        .appeal-content p:last-child {
          margin-bottom: 0;
        }
      `}</style>
    </div>
  );
}
