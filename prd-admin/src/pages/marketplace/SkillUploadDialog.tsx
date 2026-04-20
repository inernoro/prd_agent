import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileArchive, Hash, Plus, UploadCloud, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { uploadMarketplaceSkill } from '@/services';
import { toast } from '@/lib/toast';

/**
 * 海鲜市场「技能」上传弹窗。
 *
 * 遵循：
 * - `.claude/rules/frontend-modal.md`: inline style 高度 + createPortal + min-h:0
 * - `.claude/rules/zero-friction-input.md`: 拖拽 + 点击双通道，标题/详情可空走兜底
 */
interface Props {
  onClose: () => void;
  onUploaded: () => void;
}

const MAX_BYTES = 20 * 1024 * 1024;

export function SkillUploadDialog({ onClose, onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🧩');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pickFile = () => {
    const el = fileInputRef.current;
    if (!el) return;
    el.value = '';
    el.click();
  };

  const handleFile = (f: File | null) => {
    if (!f) return;
    setError('');
    const ext = f.name.toLowerCase().split('.').pop();
    if (ext !== 'zip') {
      setError('仅支持 .zip 格式的技能包');
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`文件大小不能超过 ${MAX_BYTES / 1024 / 1024}MB`);
      return;
    }
    setFile(f);
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (t.length > 20) {
      setError('单个标签不能超过 20 字符');
      return;
    }
    if (tags.length >= 10) {
      setError('最多添加 10 个标签');
      return;
    }
    if (tags.includes(t)) {
      setTagInput('');
      return;
    }
    setTags((xs) => [...xs, t]);
    setTagInput('');
  };

  const removeTag = (t: string) => setTags((xs) => xs.filter((x) => x !== t));

  const canSubmit = !!file && !uploading;

  const submit = async () => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const res = await uploadMarketplaceSkill({
        file,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        iconEmoji: iconEmoji.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      if (!res.success) {
        setError(res.error?.message || '上传失败');
        return;
      }
      toast.success('技能已发布到海鲜市场');
      onUploaded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

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
          width: 'min(560px, calc(100vw - 32px))',
          height: '82vh',
          maxHeight: '82vh',
          background:
            'linear-gradient(180deg, rgba(15, 23, 42, 0.88) 0%, rgba(2, 6, 23, 0.92) 100%)',
          border: '1px solid rgba(56, 189, 248, 0.28)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.55), inset 0 1px 1px rgba(255,255,255,0.06)',
          color: 'var(--text-primary)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 pt-4 pb-3 shrink-0"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(56, 189, 248, 0.14)', border: '1px solid rgba(56, 189, 248, 0.3)' }}
          >
            <UploadCloud size={15} style={{ color: 'rgba(125, 211, 252, 0.95)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              上传技能包到海鲜市场
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              支持 .zip 压缩包（≤ 20MB），标题与详情可留空走兜底
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center transition-colors hover:bg-white/10"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body（滚动区：min-h:0 + overflow-y:auto） */}
        <div
          className="flex-1 px-5 py-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />

          {/* 拖拽区 */}
          <div
            onClick={pickFile}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFile(e.dataTransfer.files?.[0] ?? null);
            }}
            className="flex flex-col items-center justify-center gap-2 rounded-[12px] cursor-pointer transition-all"
            style={{
              padding: file ? '16px' : '28px 16px',
              background: dragOver
                ? 'rgba(56, 189, 248, 0.12)'
                : 'rgba(255, 255, 255, 0.03)',
              border: `1px dashed ${dragOver ? 'rgba(56, 189, 248, 0.6)' : 'rgba(255, 255, 255, 0.18)'}`,
            }}
          >
            {file ? (
              <>
                <FileArchive size={24} style={{ color: 'rgba(125, 211, 252, 0.95)' }} />
                <div className="text-center">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {file.name}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    {(file.size / 1024 / 1024).toFixed(2)} MB · 点击或拖拽替换
                  </div>
                </div>
              </>
            ) : (
              <>
                <UploadCloud size={28} style={{ color: 'rgba(125, 211, 252, 0.85)' }} />
                <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  拖拽 .zip 技能包到这里，或 <span style={{ color: 'rgba(125, 211, 252, 0.95)' }}>点击选择</span>
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  上限 20 MB · 压缩包内建议包含 SKILL.md（用于自动生成摘要）
                </div>
              </>
            )}
          </div>

          {/* 标题 */}
          <div className="mt-4">
            <LabelRow label="标题" hint="留空则使用文件名（去扩展名）" />
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={file ? file.name.replace(/\.zip$/i, '') : '给你的技能起个名字'}
              maxLength={80}
              className="w-full h-9 px-3 rounded-[10px] text-[13px] focus:outline-none"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {/* 详情 */}
          <div className="mt-3">
            <LabelRow
              label="详情"
              hint="留空将尝试从压缩包内的 SKILL.md 用 LLM 自动提取 30 字摘要"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说清这个技能做什么（不超过 200 字）"
              rows={3}
              maxLength={200}
              className="w-full px-3 py-2 rounded-[10px] text-[13px] focus:outline-none resize-none"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {/* Icon */}
          <div className="mt-3">
            <LabelRow label="图标（emoji）" hint="粘贴任意 emoji，默认 🧩" />
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={iconEmoji}
                onChange={(e) => setIconEmoji(e.target.value)}
                maxLength={4}
                className="w-16 h-9 px-2 rounded-[10px] text-center text-[18px] focus:outline-none"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'var(--text-primary)',
                }}
              />
              <div className="flex items-center gap-1 flex-wrap">
                {['🧩', '🤖', '✨', '⚡', '📚', '🎨', '🔧', '🚀', '📦', '🐟'].map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setIconEmoji(e)}
                    className="w-7 h-7 flex items-center justify-center rounded-[8px] transition-colors hover:bg-white/10"
                    style={{
                      background: iconEmoji === e ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
                      border: `1px solid ${iconEmoji === e ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.08)'}`,
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Tags */}
          <div className="mt-3">
            <LabelRow label="标签" hint="回车添加，最多 10 个（用于顶部筛选）" />
            <div className="flex items-center gap-2">
              <div
                className="flex items-center flex-1 min-w-0 px-2 rounded-[10px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  height: 36,
                }}
              >
                <Hash size={12} style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTag();
                    }
                    if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
                      setTags((xs) => xs.slice(0, -1));
                    }
                  }}
                  placeholder={tags.length === 0 ? '如：英文翻译、PRD、审查、导出…' : '继续添加...'}
                  maxLength={20}
                  className="flex-1 h-full px-2 text-[13px] bg-transparent focus:outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />
              </div>
              <Button variant="secondary" size="xs" onClick={addTag} disabled={!tagInput.trim()}>
                <Plus size={12} />
                加标签
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px]"
                    style={{
                      background: 'rgba(56, 189, 248, 0.14)',
                      border: '1px solid rgba(56, 189, 248, 0.35)',
                      color: 'rgba(186, 230, 253, 0.95)',
                    }}
                  >
                    <Hash size={9} />
                    {t}
                    <button
                      type="button"
                      onClick={() => removeTag(t)}
                      className="hover:opacity-70"
                      aria-label={`删除标签 ${t}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div
              className="mt-3 rounded-[10px] px-3 py-2 text-[12px]"
              style={{
                background: 'linear-gradient(135deg, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.05) 100%)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: 'rgba(252, 165, 165, 0.96)',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3 shrink-0"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <Button variant="ghost" size="sm" onClick={onClose} disabled={uploading}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            <UploadCloud size={13} />
            {uploading ? '上传中...' : '发布到海鲜市场'}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function LabelRow({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-1.5">
      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      {hint && (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}
