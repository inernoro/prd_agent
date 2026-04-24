import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ExternalLink,
  FileArchive,
  Globe,
  Hash,
  ImageIcon,
  Link as LinkIcon,
  Plus,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { uploadMarketplaceSkill } from '@/services';
import { listSites, type HostedSite } from '@/services/real/webPages';
import { toast } from '@/lib/toast';

/**
 * 海鲜市场「技能」上传弹窗（重设计版）。
 *
 * 新增能力：
 * - 封面图上传（替代 emoji 作为卡片主视觉；兜底仍可选 emoji）
 * - 预览地址（external URL 或选自己的 hosted_sites）
 *
 * 仍然遵循：
 * - `.claude/rules/frontend-modal.md`: inline style 高度 + createPortal + min-h:0
 * - `.claude/rules/zero-friction-input.md`: 双通道（上传/手输 + 下拉/URL）
 */
interface Props {
  onClose: () => void;
  onUploaded: () => void;
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const ALLOWED_COVER_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

type PreviewTab = 'none' | 'hosted' | 'external';

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

  // 封面图
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  // 预览地址
  const [previewTab, setPreviewTab] = useState<PreviewTab>('none');
  const [previewUrlInput, setPreviewUrlInput] = useState('');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');

  // hosted_sites 列表
  const [sites, setSites] = useState<HostedSite[]>([]);
  const [loadingSites, setLoadingSites] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 首次切到「选已有托管站点」时才拉列表
  useEffect(() => {
    if (previewTab !== 'hosted' || sites.length > 0 || loadingSites) return;
    setLoadingSites(true);
    listSites({ limit: 100, sort: 'updated_desc' })
      .then((res) => {
        if (res.success && res.data?.items) setSites(res.data.items);
      })
      .catch(() => {
        /* 静默：用户可在 tab 下方看到空态提示 */
      })
      .finally(() => setLoadingSites(false));
  }, [previewTab, sites.length, loadingSites]);

  // 封面图本地预览 URL（blob）生命周期
  useEffect(() => {
    if (!coverFile) {
      setCoverPreview(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  const pickFile = () => {
    const el = fileInputRef.current;
    if (!el) return;
    el.value = '';
    el.click();
  };

  const pickCover = () => {
    const el = coverInputRef.current;
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
    if (f.size > MAX_ZIP_BYTES) {
      setError(`文件大小不能超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB`);
      return;
    }
    setFile(f);
  };

  const handleCover = (f: File | null) => {
    if (!f) return;
    setError('');
    if (f.size > MAX_COVER_BYTES) {
      setError(`封面图不能超过 ${MAX_COVER_BYTES / 1024 / 1024}MB`);
      return;
    }
    if (f.type && !ALLOWED_COVER_MIME.includes(f.type)) {
      setError('封面图仅支持 png / jpg / webp / gif');
      return;
    }
    setCoverFile(f);
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

  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedSiteId) ?? null,
    [sites, selectedSiteId],
  );

  const submit = async () => {
    if (!file) return;

    // 预览地址校验
    let previewSource: 'external' | 'hosted_site' | undefined;
    let previewUrl: string | undefined;
    let previewHostedSiteId: string | undefined;

    if (previewTab === 'external') {
      const raw = previewUrlInput.trim();
      if (raw) {
        if (!/^https?:\/\//i.test(raw)) {
          setError('预览地址必须以 http:// 或 https:// 开头');
          return;
        }
        previewSource = 'external';
        previewUrl = raw;
      }
    } else if (previewTab === 'hosted') {
      if (selectedSiteId) {
        previewSource = 'hosted_site';
        previewHostedSiteId = selectedSiteId;
      }
    }

    setUploading(true);
    setError('');
    try {
      const res = await uploadMarketplaceSkill({
        file,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        iconEmoji: iconEmoji.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        coverImage: coverFile ?? undefined,
        previewSource,
        previewUrl,
        previewHostedSiteId,
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
          width: 'min(640px, calc(100vw - 32px))',
          height: '88vh',
          maxHeight: '88vh',
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
              .zip ≤ 20MB · 标题/详情留空自动兜底 · 可选封面图 + 预览地址
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

        {/* Body */}
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
          <input
            ref={coverInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => handleCover(e.target.files?.[0] ?? null)}
          />

          {/* 1. zip 拖拽区 */}
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
              background: dragOver ? 'rgba(56, 189, 248, 0.12)' : 'rgba(255, 255, 255, 0.03)',
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
                  上限 20 MB · 含 SKILL.md 时自动提取摘要（先规则提取，失败兜底 LLM）
                </div>
              </>
            )}
          </div>

          {/* 2. 封面图 */}
          <div className="mt-4">
            <LabelRow
              label="封面图"
              hint="卡片主视觉；未上传则使用下方 emoji 兜底"
            />
            <div className="flex items-center gap-3">
              <div
                onClick={pickCover}
                className="flex items-center justify-center rounded-[12px] cursor-pointer overflow-hidden transition-colors"
                style={{
                  width: 104,
                  height: 104,
                  flexShrink: 0,
                  background: coverPreview
                    ? `url(${coverPreview}) center/cover`
                    : 'rgba(255, 255, 255, 0.03)',
                  border: `1px dashed ${coverPreview ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.18)'}`,
                }}
              >
                {!coverPreview && (
                  <div className="flex flex-col items-center gap-1.5">
                    <ImageIcon size={22} style={{ color: 'rgba(125, 211, 252, 0.85)' }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      点击上传
                    </span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>
                  支持 png / jpg / webp / gif，单张 ≤ 5MB
                </div>
                <div className="text-[11px] leading-5 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  海鲜市场会用这张图作为瀑布流卡片的封面。
                </div>
                {coverFile && (
                  <div className="flex items-center gap-2 mt-2">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px]"
                      style={{
                        background: 'rgba(56, 189, 248, 0.14)',
                        border: '1px solid rgba(56, 189, 248, 0.35)',
                        color: 'rgba(186, 230, 253, 0.95)',
                      }}
                    >
                      {coverFile.name.length > 22
                        ? `${coverFile.name.slice(0, 20)}…`
                        : coverFile.name}
                      <button
                        type="button"
                        onClick={() => setCoverFile(null)}
                        className="hover:opacity-70"
                        aria-label="移除封面图"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 3. 标题 */}
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

          {/* 4. 详情 */}
          <div className="mt-3">
            <LabelRow
              label="详情"
              hint="留空 → 规则提取 SKILL.md → 失败兜底 LLM 30 字摘要"
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

          {/* 5. 预览地址 */}
          <div className="mt-3">
            <LabelRow label="预览地址" hint="可选：让下载者先在网页上看看效果" />
            <div className="flex items-center gap-1 mb-2">
              <PreviewTabBtn
                active={previewTab === 'none'}
                onClick={() => setPreviewTab('none')}
                icon={<Sparkles size={12} />}
                label="不设置"
              />
              <PreviewTabBtn
                active={previewTab === 'hosted'}
                onClick={() => setPreviewTab('hosted')}
                icon={<Globe size={12} />}
                label="我的托管站点"
              />
              <PreviewTabBtn
                active={previewTab === 'external'}
                onClick={() => setPreviewTab('external')}
                icon={<LinkIcon size={12} />}
                label="外部 URL"
              />
            </div>

            {previewTab === 'hosted' && (
              <div>
                {loadingSites ? (
                  <div className="text-[12px] py-2" style={{ color: 'var(--text-muted)' }}>
                    正在加载我的托管站点...
                  </div>
                ) : sites.length === 0 ? (
                  <div
                    className="px-3 py-2 rounded-[10px] text-[12px]"
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    你还没有托管站点。先去「网页托管」上传一份即可在这里选中。
                  </div>
                ) : (
                  <select
                    value={selectedSiteId}
                    onChange={(e) => setSelectedSiteId(e.target.value)}
                    className="w-full h-9 px-3 rounded-[10px] text-[13px] focus:outline-none"
                    style={{
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid rgba(255, 255, 255, 0.12)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <option value="">— 选择一个托管站点 —</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title || '未命名'} ({s.visibility === 'public' ? '公开' : '私有'})
                      </option>
                    ))}
                  </select>
                )}
                {selectedSite?.siteUrl && (
                  <a
                    href={selectedSite.siteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-1.5 text-[11px]"
                    style={{ color: 'rgba(125, 211, 252, 0.95)' }}
                  >
                    <ExternalLink size={10} />
                    {selectedSite.siteUrl}
                  </a>
                )}
              </div>
            )}

            {previewTab === 'external' && (
              <input
                type="url"
                value={previewUrlInput}
                onChange={(e) => setPreviewUrlInput(e.target.value)}
                placeholder="https://example.com/preview"
                maxLength={512}
                className="w-full h-9 px-3 rounded-[10px] text-[13px] focus:outline-none"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'var(--text-primary)',
                }}
              />
            )}
          </div>

          {/* 6. Emoji 兜底图标 */}
          <div className="mt-3">
            <LabelRow label="图标（emoji）" hint="未上传封面图时作为卡片兜底视觉" />
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

          {/* 7. 标签 */}
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

function PreviewTabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] transition-colors"
      style={{
        background: active ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.04)',
        border: `1px solid ${active ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
        color: active ? 'rgba(186, 230, 253, 0.95)' : 'var(--text-secondary)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}
