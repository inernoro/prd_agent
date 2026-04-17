import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lightbulb, X, Star } from 'lucide-react';
import { Button } from '@/components/design/Button';

interface Props {
  /** 父节点标题,用作 placeholder 里的上下文 */
  parentTitle?: string;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
}

// 快速灵感预设(防止用户盯着空白输入框发呆,呼应零摩擦输入原则)
const PRESETS = [
  '从移动端体验角度发散',
  '聚焦 B 端企业用户场景',
  '结合 AI 能力重新设计',
  '考虑离线或弱网场景',
  '从数据分析与可观测性切入',
  '关注合规/安全/隐私场景',
];

/**
 * 灵感对话框:让用户补充提示词后触发探索
 * 遵循 .claude/rules/frontend-modal.md:inline style 高度 + createPortal + min-h:0
 * 遵循 .claude/rules/zero-friction-input.md:预设快捷选项,杜绝空白发呆
 */
export function EmergenceInspireDialog({ parentTitle, onClose, onSubmit }: Props) {
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动聚焦
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && prompt.trim()) {
        onSubmit(prompt.trim());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prompt, onClose, onSubmit]);

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col rounded-[16px]"
        style={{
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: '80vh',
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(234,179,8,0.2)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.08)',
        }}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.15)' }}>
            <Lightbulb size={15} style={{ color: 'rgba(234,179,8,0.9)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>增加灵感</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {parentTitle
                ? <>给 <span style={{ color: 'var(--text-secondary)' }}>{parentTitle}</span> 指定一个探索方向</>
                : '写一句你的想法,让 AI 按你的方向发散'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={14} />
          </button>
        </div>

        {/* 正文(可滚) */}
        <div
          className="flex-1 px-5 py-4 flex flex-col gap-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例:从移动端用户体验角度发散,关注加载性能和离线可用..."
            rows={4}
            className="w-full p-3 text-[12px] rounded-[10px] resize-none"
            style={{
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'var(--text-primary)',
              outline: 'none',
              lineHeight: 1.6,
            }}
          />

          <div>
            <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>快速灵感(点一下自动填入):</p>
            <div className="flex gap-1.5 flex-wrap">
              {PRESETS.map(preset => (
                <button
                  key={preset}
                  onClick={() => setPrompt(prev => prev ? `${prev}\n${preset}` : preset)}
                  className="surface-row text-[11px] px-2.5 py-1 rounded-[8px] cursor-pointer transition-colors duration-150 hover:brightness-125"
                  style={{
                    background: 'rgba(234,179,8,0.06)',
                    border: '1px solid rgba(234,179,8,0.14)',
                    color: 'rgba(234,179,8,0.85)',
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ⌘/Ctrl + Enter 快速提交
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              size="xs"
              disabled={!prompt.trim()}
              onClick={() => onSubmit(prompt.trim())}
            >
              <Star size={12} /> 带着灵感探索
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
