import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Share2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { MarketplaceSkillDto } from '@/services/contracts/marketplaceSkills';
import { SkillContentBrowser } from './SkillContentBrowser';
import { useSkillShare } from './useSkillShare';

/**
 * 技能详情弹窗 —— 近全屏（82vw / 85vh），左文件树 + 右内容，默认 SKILL.md。
 * 遵守 .claude/rules/frontend-modal.md：createPortal、inline 关键尺寸、min-h-0 滚动区、ESC + 蒙版关闭。
 */
export function SkillDetailModal({
  open,
  skill,
  onClose,
}: {
  open: boolean;
  skill: MarketplaceSkillDto;
  onClose: () => void;
}) {
  const { sharing, shareSkill } = useSkillShare();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => {
        // createPortal 下 React 合成事件仍沿组件树冒泡回卡片 onClick，
        // 不 stop 的话点遮罩关闭后会立刻被卡片 onClick 重新打开
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col rounded-xl border"
        style={{
          width: '82vw',
          maxWidth: '1400px',
          height: '85vh',
          maxHeight: '85vh',
          background: 'var(--bg-card)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
        }}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center gap-3 px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-[20px] leading-none">{skill.iconEmoji}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {skill.title}
            </div>
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {skill.originalFileName}
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={sharing}
            onClick={() => shareSkill(skill.id)}
            title="生成公开分享链接"
          >
            <Share2 size={13} />
            {sharing ? '生成中…' : '分享'}
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] transition-colors hover:bg-white/8"
            style={{ color: 'var(--text-muted)' }}
            title="关闭 (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1" style={{ minHeight: 0 }}>
          <SkillContentBrowser zipUrl={skill.zipUrl} sizeBytes={skill.zipSizeBytes} />
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export default SkillDetailModal;
