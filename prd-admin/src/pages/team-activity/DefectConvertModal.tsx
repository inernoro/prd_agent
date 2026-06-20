/**
 * 转为缺陷弹窗：VOC 闭环里「转为缺陷」不再直接创建并发送，而是先弹窗让用户核对/编辑预填内容、
 * 指定发给谁（指派人）、选严重度，确认后才真正调 createDefect + setInsightState（逻辑仍在父组件）。
 * 遵守 .claude/rules/frontend-modal.md：createPortal 到 body + 布局尺寸 inline style +
 * 滚动区 minHeight:0 + overscrollBehavior contain + z-[100]+ + ESC/点遮罩关闭。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';

export type DefectConvertDraft = {
  title: string;
  content: string;
  assigneeUserId: string;
  severity: 'major' | 'minor';
};

const SEVERITY_OPTIONS: { key: 'major' | 'minor'; label: string }[] = [
  { key: 'major', label: '主要（major）' },
  { key: 'minor', label: '次要（minor）' },
];

export function DefectConvertModal({
  draft,
  submitting,
  onConfirm,
  onClose,
}: {
  /** 预填草稿（标题/正文/默认严重度），由父组件按当前洞察生成 */
  draft: DefectConvertDraft;
  submitting?: boolean;
  /** 确认创建：父组件复用 createDefect + setTeamActivityInsightState */
  onConfirm: (draft: DefectConvertDraft) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [content, setContent] = useState(draft.content);
  const [assigneeUserId, setAssigneeUserId] = useState(draft.assigneeUserId);
  const [severity, setSeverity] = useState<'major' | 'minor'>(draft.severity);

  // ESC 关闭（提交中不允许关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const canSubmit = title.trim().length > 0 && content.trim().length > 0 && !submitting;

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', padding: '4vh 4vw' }}
      onClick={() => !submitting && onClose()}
    >
      <div
        className="rounded-2xl border border-white/10 bg-[#16171b] flex flex-col w-full"
        style={{ maxWidth: 560, maxHeight: '88vh', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-white/[0.06] shrink-0">
          <span className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: 'rgba(245,158,11,0.15)' }}>
            <Bug size={15} className="text-amber-300" />
          </span>
          <div className="flex flex-col">
            <span className="text-[14px] font-semibold text-white/90">转为缺陷</span>
            <span className="text-[11px] text-white/40">核对并编辑内容后再创建，可指定发给谁</span>
          </div>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            title="关闭"
            className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单滚动区 */}
        <div
          className="px-5 py-4 flex flex-col gap-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-white/55 font-medium">缺陷标题</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-9 px-3 rounded-lg text-[13px] text-white/90 bg-white/[0.04] border border-white/12 focus:border-amber-400/60 outline-none transition-colors"
              placeholder="一句话描述这个缺陷"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-white/55 font-medium">缺陷正文</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={9}
              className="px-3 py-2.5 rounded-lg text-[12.5px] leading-relaxed text-white/85 font-mono bg-white/[0.04] border border-white/12 focus:border-amber-400/60 outline-none transition-colors resize-y"
              style={{ minHeight: 160 }}
              placeholder="证据 / 量化指标 / 改进建议（已自动预填，可修改）"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-white/55 font-medium">指派给（发给谁）</span>
            <UserSearchSelect
              value={assigneeUserId}
              onChange={setAssigneeUserId}
              placeholder="搜索并选择处理人，可留空"
            />
            {!assigneeUserId ? (
              <span className="text-[11px] text-amber-200/60">留空表示暂不指派，缺陷将进入待分配状态</span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-white/55 font-medium">严重度</span>
            <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 w-fit">
              {SEVERITY_OPTIONS.map((opt) => {
                const active = severity === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSeverity(opt.key)}
                    className={`px-3 py-1 rounded-md text-[12px] transition-colors cursor-pointer ${
                      active
                        ? opt.key === 'major'
                          ? 'bg-rose-500/15 text-rose-200'
                          : 'bg-amber-500/15 text-amber-200'
                        : 'text-white/45 hover:text-white/75'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-white/[0.06] shrink-0">
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            className="inline-flex items-center gap-1 px-3 h-9 rounded-lg text-[12px] border bg-white/[0.03] text-white/55 border-white/10 hover:text-white/85 hover:border-white/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => canSubmit && onConfirm({ title: title.trim(), content: content.trim(), assigneeUserId, severity })}
            style={!canSubmit ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            className="inline-flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[12px] border bg-amber-500/20 text-amber-200 border-amber-500/35 hover:bg-amber-500/30 transition-colors cursor-pointer"
          >
            {submitting ? <MapSpinner size={13} /> : <Bug size={13} />}
            {submitting ? '创建中…' : '确认创建'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
