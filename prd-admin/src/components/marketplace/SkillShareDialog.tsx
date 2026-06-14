import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Share2, Link2, Clock } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { useSkillShareDialogStore } from './skillShareDialogStore';
import { useSkillShare } from './useSkillShare';

/**
 * 技能分享弹窗（全局单例）——选有效期 → 生成公开免登录链接并复制。
 * 由 App 根挂载一次，任意处 `skillShareDialog.open({ id, title })` 拉起。
 * 遵守 .claude/rules/frontend-modal.md：createPortal 到 body、inline 关键尺寸、ESC + 蒙版关闭。
 */
const EXPIRY_OPTIONS: { label: string; days: number }[] = [
  { label: '永久有效', days: 0 },
  { label: '7 天后过期', days: 7 },
  { label: '30 天后过期', days: 30 },
  { label: '90 天后过期', days: 90 },
];

export function SkillShareDialog() {
  const target = useSkillShareDialogStore((s) => s.target);
  const close = useSkillShareDialogStore((s) => s.close);
  const { sharing, shareSkill } = useSkillShare();
  const [days, setDays] = useState(0);

  // 每次打开重置为「永久」
  useEffect(() => {
    if (target) setDays(0);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sharing) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, sharing, close]);

  if (!target) return null;

  const onGenerate = async () => {
    const ok = await shareSkill(target.id, days);
    if (ok) close();
  };

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => {
        e.stopPropagation();
        if (!sharing) close();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="surface-popover flex flex-col rounded-xl"
        style={{ width: '92vw', maxWidth: '420px', color: 'var(--text-primary)' }}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center gap-2.5 px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <Share2 size={16} style={{ color: 'var(--accent-primary, rgba(56,189,248,0.9))' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              分享技能
            </div>
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {target.title}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { if (!sharing) close(); }}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] transition-colors hover:bg-white/8"
            style={{ color: 'var(--text-muted)' }}
            title="关闭 (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-[12px]" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
            生成一个公开链接，任何人无需登录即可在线浏览并下载该技能压缩包。
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              <Clock size={12} /> 有效期
            </span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="h-9 rounded-[8px] px-3 text-[13px]"
              style={{
                background: 'var(--bg-input, rgba(255,255,255,0.04))',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>

        {/* Footer */}
        <div
          className="shrink-0 flex items-center justify-end gap-2 px-5 py-3.5 border-t"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <Button size="sm" variant="secondary" disabled={sharing} onClick={() => close()}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={sharing} onClick={onGenerate}>
            <Link2 size={13} />
            {sharing ? '生成中…' : '生成并复制链接'}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export default SkillShareDialog;
