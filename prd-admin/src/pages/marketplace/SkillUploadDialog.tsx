import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import JSZip from 'jszip';
import {
  ChevronRight,
  ExternalLink,
  FileArchive,
  FileText,
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
import { updateMarketplaceSkill, uploadMarketplaceSkill } from '@/services';
import { listSites, type HostedSite } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import { resizeCoverImage } from '@/lib/imageResize';
import type { MarketplaceSkillDto } from '@/services/contracts/marketplaceSkills';

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
  editingSkill?: MarketplaceSkillDto | null;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
// 客户端 resize 后通常 < 200KB，上限放 2MB 防 GIF/极大原图（resize 失败时兜底也仍允许上传）
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const ALLOWED_COVER_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ALLOWED_SINGLE_EXT = ['md', 'markdown', 'txt'];
const FIELD_CLASS = 'prd-field h-9 w-full rounded-[10px] px-3 text-[13px] focus:outline-none';
const TAG_CLASS = 'surface-action-accent inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px]';

function isSingleFile(f: File): boolean {
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  return ALLOWED_SINGLE_EXT.includes(ext);
}

async function wrapSingleFileAsZip(f: File): Promise<File> {
  const zip = new JSZip();
  const baseName = f.name.replace(/\.(md|markdown|txt)$/i, '');
  const skillFolder = zip.folder(baseName || 'skill');
  // 单文件统一作为 SKILL.md 放入 zip，便于后端按既有规则提取摘要
  const text = await f.text();
  (skillFolder ?? zip).file('SKILL.md', text);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return new File([blob], `${baseName || 'skill'}.zip`, { type: 'application/zip' });
}

type PreviewTab = 'none' | 'hosted' | 'external';

export function SkillUploadDialog({ onClose, onUploaded, editingSkill }: Props) {
  const isEditing = !!editingSkill;
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(editingSkill?.title ?? '');
  const [description, setDescription] = useState(editingSkill?.description ?? '');
  const [descriptionAiActive, setDescriptionAiActive] = useState(false);
  const [descriptionUserTouched, setDescriptionUserTouched] = useState(!!editingSkill?.description);
  const [iconEmoji, setIconEmoji] = useState(editingSkill?.iconEmoji ?? '🧩');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>(editingSkill?.tags ?? []);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const aiAbortRef = useRef<AbortController | null>(null);

  // 封面图
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(editingSkill?.coverImageUrl ?? null);
  const [removeExistingCover, setRemoveExistingCover] = useState(false);

  // 预览地址
  const [previewTab, setPreviewTab] = useState<PreviewTab>(
    editingSkill?.previewSource === 'hosted_site'
      ? 'hosted'
      : editingSkill?.previewSource === 'external'
        ? 'external'
        : 'none',
  );
  const [previewUrlInput, setPreviewUrlInput] = useState(editingSkill?.previewUrl ?? '');
  const [selectedSiteId, setSelectedSiteId] = useState<string>(editingSkill?.previewHostedSiteId ?? '');

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
      setCoverPreview(removeExistingCover ? null : editingSkill?.coverImageUrl ?? null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile, editingSkill?.coverImageUrl, removeExistingCover]);

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
    const ext = (f.name.toLowerCase().split('.').pop() ?? '');
    const isZip = ext === 'zip';
    if (!isZip && !ALLOWED_SINGLE_EXT.includes(ext)) {
      setError('支持 .zip 技能包，或单个 .md / .markdown / .txt 文件');
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError(`文件大小不能超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`);
      return;
    }
    setFile(f);
    void requestAiDraft(f);
  };

  async function extractSkillMd(f: File): Promise<string> {
    if (isSingleFile(f)) {
      return await f.text();
    }
    try {
      const zip = await JSZip.loadAsync(f);
      const entryName = Object.keys(zip.files).find((name) => {
        const lower = name.toLowerCase();
        return lower.endsWith('skill.md') || lower.endsWith('/skill.md') || lower === 'skill.md';
      });
      if (!entryName) return '';
      const entry = zip.file(entryName);
      return entry ? await entry.async('string') : '';
    } catch {
      return '';
    }
  }

  async function requestAiDraft(f: File) {
    // 用户已经手动写了详情就不抢走他的输入
    if (descriptionUserTouched) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    let skillMd = '';
    try {
      skillMd = await extractSkillMd(f);
    } catch {
      return;
    }
    if (!skillMd.trim()) return;

    setDescriptionAiActive(true);
    setDescription('');
    try {
      const token = useAuthStore.getState().token;
      const resp = await fetch('/api/marketplace/skills/draft-description', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ content: skillMd, fileName: f.name }),
      });
      if (!resp.ok || !resp.body) {
        setDescriptionAiActive(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const ev of events) {
          if (descriptionUserTouched) {
            controller.abort();
            return;
          }
          // 区分 event 类型：error / done 走错误/结束分支，default(=delta) 才拼接
          let eventType = '';
          const dataLines: string[] = [];
          for (const line of ev.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (dataLines.length === 0) continue;
          if (eventType === 'error') {
            // 出错时不要把 JSON 报错塞进详情框；详情清空，错误另行提示
            setDescription('');
            try {
              const obj = JSON.parse(dataLines.join('\n'));
              setError(typeof obj?.message === 'string' ? `AI 起草失败：${obj.message}` : 'AI 起草失败');
            } catch {
              setError('AI 起草失败');
            }
            controller.abort();
            return;
          }
          if (eventType === 'done') return;
          // 默认事件 = 文本 delta；多行 data 按 SSE 规范以 \n 拼回
          const text = dataLines.join('\n');
          if (text === '[DONE]') return;
          accumulated += text;
          setDescription(accumulated.slice(0, 200));
        }
      }
    } catch {
      /* 静默：网络/取消都不打扰用户 */
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      setDescriptionAiActive(false);
    }
  }

  const handleCover = async (f: File | null) => {
    if (!f) return;
    setError('');
    if (f.type && !ALLOWED_COVER_MIME.includes(f.type)) {
      setError('封面图仅支持 png / jpg / webp / gif');
      return;
    }
    // 客户端缩到 ≤ 1280×720 + webp(0.82)，原图 4000×3000 也能瘦到 ~200KB
    let final: File = f;
    try {
      const r = await resizeCoverImage(f);
      final = r.file;
    } catch {
      // resize 失败（极少数浏览器/损坏文件）兜底用原图，下面尺寸校验把关
    }
    if (final.size > MAX_COVER_BYTES) {
      setError(`封面图过大（${(final.size / 1024 / 1024).toFixed(1)}MB），请换一张小一些的`);
      return;
    }
    setCoverFile(final);
    setRemoveExistingCover(false);
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

  const canSubmit = (isEditing || !!file) && !uploading;

  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedSiteId) ?? null,
    [sites, selectedSiteId],
  );

  const submit = async () => {
    if (!isEditing && !file) return;

    // 预览地址校验
    let previewSource: 'external' | 'hosted_site' | 'none' | undefined;
    let previewUrl: string | undefined;
    let previewHostedSiteId: string | undefined;

    if (isEditing && previewTab === 'none') {
      previewSource = 'none';
    } else if (previewTab === 'external') {
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
      const payload = {
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        iconEmoji: iconEmoji.trim() || undefined,
        tags,
        coverImage: coverFile ?? undefined,
        previewSource,
        previewUrl,
        previewHostedSiteId,
      };
      let uploadFile = file!;
      if (!isEditing && uploadFile && isSingleFile(uploadFile)) {
        uploadFile = await wrapSingleFileAsZip(uploadFile);
      }
      const res = isEditing
        ? await updateMarketplaceSkill({
          id: editingSkill.id,
          ...payload,
          removeCover: removeExistingCover,
        })
        : await uploadMarketplaceSkill({
          file: uploadFile,
          ...payload,
          tags: tags.length > 0 ? tags : undefined,
          previewSource: previewSource === 'none' ? undefined : previewSource,
        });
      if (!res.success) {
        setError(res.error?.message || (isEditing ? '保存失败' : '上传失败'));
        return;
      }
      toast.success(isEditing ? '技能信息已更新' : '技能已发布到海鲜市场');
      onUploaded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : (isEditing ? '保存失败' : '上传失败'));
    } finally {
      setUploading(false);
    }
  };

  const modal = (
    <div
      className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="surface-popover flex h-[88vh] max-h-[88vh] w-[min(640px,calc(100vw-32px))] flex-col rounded-[16px] text-token-primary"
      >
        {/* Header */}
        <div
          className="surface-panel-header flex shrink-0 items-center gap-3 px-5 pb-3 pt-4"
        >
          <div
            className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]"
          >
            <UploadCloud size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[14px] font-semibold text-token-primary">
              {isEditing ? '编辑技能信息' : '上传技能包到海鲜市场'}
            </h3>
            <p className="mt-0.5 text-[11px] text-token-muted">
              {isEditing
                ? '只能修改自己上传的技能展示信息 · zip 包本体不会被静默替换'
                : '.zip 或单个 .md ≤ 20 MB · 拖入后 AI 自动起草详情'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted transition-colors hover:bg-white/10 hover:text-token-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.md,.markdown,.txt,application/zip,application/x-zip-compressed,text/markdown,text/plain"
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
          {isEditing ? (
            <div className="surface-inset flex items-center gap-3 rounded-[12px] px-3 py-3">
              <FileArchive size={20} className="text-token-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-token-primary">
                  {editingSkill.originalFileName || '已上传技能包'}
                </div>
                <div className="mt-0.5 text-[11px] text-token-muted">
                  编辑模式只改市场展示信息；需要替换 zip 时请重新上传一个新版本。
                </div>
              </div>
            </div>
          ) : (
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
                  {isSingleFile(file) ? (
                    <FileText size={24} className="text-token-accent" />
                  ) : (
                    <FileArchive size={24} className="text-token-accent" />
                  )}
                  <div className="text-center">
                    <div className="text-[13px] font-medium text-token-primary">
                      {file.name}
                    </div>
                    <div className="mt-1 text-[11px] text-token-muted">
                      {(file.size / 1024 / 1024).toFixed(2)} MB · 点击或拖拽替换
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <UploadCloud size={28} className="text-token-accent opacity-85" />
                  <div className="text-[13px] text-token-secondary">
                    拖入 .zip 技能包 或 单个 SKILL.md，或 <span className="text-token-accent">点击选择</span>
                  </div>
                  <div className="text-[11px] text-token-muted">
                    .zip / .md / .markdown / .txt · 单文件 ≤ 20 MB
                  </div>
                </>
              )}
            </div>
          )}

          {/* 2. 标题 */}
          <div className="mt-4">
            <LabelRow label="标题" />
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={file ? file.name.replace(/\.(zip|md|markdown|txt)$/i, '') : '留空将用文件名'}
              maxLength={80}
              className={FIELD_CLASS}
            />
          </div>

          {/* 3. 详情 */}
          <div className="mt-3">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-token-secondary">
                详情
                {descriptionAiActive ? (
                  <span className="surface-action-accent inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px]">
                    <Sparkles size={9} className="animate-pulse" />
                    AI 起草中…
                  </span>
                ) : description && !descriptionUserTouched ? (
                  <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] text-token-accent">
                    <Sparkles size={9} />
                    AI 生成
                  </span>
                ) : null}
              </span>
              <span className="text-[10px] text-token-muted">
                {file ? '可直接修改，不满意就清空' : '留空则上传时自动生成'}
              </span>
            </div>
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setDescriptionUserTouched(true);
                aiAbortRef.current?.abort();
              }}
              placeholder="一句话说清这个技能做什么（不超过 200 字）"
              rows={3}
              maxLength={200}
              className="prd-field w-full resize-none rounded-[10px] px-3 py-2 text-[13px] focus:outline-none"
            />
          </div>

          {/* 4. 进阶（折叠） */}
          <details className="mt-4 group" open={isEditing}>
            <summary className="flex items-center gap-1.5 cursor-pointer list-none select-none text-[12px] text-token-secondary hover:text-token-primary py-1">
              <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
              进阶（封面 / 图标 / 预览 / 标签）
              <span className="text-[10px] text-token-muted">— 不填也能发布</span>
            </summary>

            <div className="mt-3 space-y-4">
              {/* 4.1 封面图 */}
              <div>
                <LabelRow label="封面图" hint="未上传则用下方 emoji 兜底" />
                <div className="flex items-center gap-3">
                  <div
                    onClick={pickCover}
                    className="flex items-center justify-center rounded-[12px] cursor-pointer overflow-hidden transition-colors"
                    style={{
                      width: 88,
                      height: 88,
                      flexShrink: 0,
                      background: coverPreview
                        ? `url(${coverPreview}) center/cover`
                        : 'rgba(255, 255, 255, 0.03)',
                      border: `1px dashed ${coverPreview ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.18)'}`,
                    }}
                  >
                    {!coverPreview && (
                      <div className="flex flex-col items-center gap-1">
                        <ImageIcon size={20} className="text-token-accent opacity-85" />
                        <span className="text-[10px] text-token-muted">点击上传</span>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-token-muted">
                      png / jpg / webp / gif · ≤ 5 MB
                    </div>
                    {coverFile && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={TAG_CLASS}>
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
                    {editingSkill?.coverImageUrl && !coverFile && !removeExistingCover && (
                      <Button
                        variant="secondary"
                        size="xs"
                        className="mt-2"
                        onClick={() => setRemoveExistingCover(true)}
                      >
                        移除当前封面
                      </Button>
                    )}
                    {removeExistingCover && !coverFile && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="mt-2"
                        onClick={() => setRemoveExistingCover(false)}
                      >
                        恢复当前封面
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* 4.2 Emoji */}
              <div>
                <LabelRow label="图标（emoji）" hint="无封面时的兜底视觉" />
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={iconEmoji}
                    onChange={(e) => setIconEmoji(e.target.value)}
                    maxLength={4}
                    className="prd-field h-9 w-16 rounded-[10px] px-2 text-center text-[18px] focus:outline-none"
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

              {/* 4.3 预览地址 */}
              <div>
                <LabelRow label="预览地址" hint="让下载者先看效果" />
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
                      <div className="py-2 text-[12px] text-token-muted">
                        正在加载我的托管站点...
                      </div>
                    ) : sites.length === 0 ? (
                      <div className="surface-inset rounded-[10px] px-3 py-2 text-[12px] text-token-muted">
                        你还没有托管站点。先去「网页托管」上传一份即可在这里选中。
                      </div>
                    ) : (
                      <select
                        value={selectedSiteId}
                        onChange={(e) => setSelectedSiteId(e.target.value)}
                        className={FIELD_CLASS}
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
                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-token-accent"
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
                    className={FIELD_CLASS}
                  />
                )}
              </div>

              {/* 4.4 标签 */}
              <div>
                <LabelRow label="标签" hint="回车添加，最多 10 个" />
                <div className="flex items-center gap-2">
                  <div className="prd-field flex h-9 min-w-0 flex-1 items-center rounded-[10px] px-2">
                    <Hash size={12} className="text-token-muted" />
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
                      className="h-full flex-1 bg-transparent px-2 text-[13px] text-token-primary focus:outline-none"
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
                      <span key={t} className={TAG_CLASS}>
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
            </div>
          </details>

          {error && (
            <div
              className="surface-state-danger mt-3 rounded-[10px] px-3 py-2 text-[12px]"
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="surface-panel-footer flex shrink-0 items-center justify-end gap-2 px-5 py-3"
        >
          <Button variant="ghost" size="sm" onClick={onClose} disabled={uploading}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            <UploadCloud size={13} />
            {uploading
              ? (isEditing ? '保存中...' : '上传中...')
              : (isEditing ? '保存修改' : '发布到海鲜市场')}
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
      <span className="text-[11px] font-semibold text-token-secondary">
        {label}
      </span>
      {hint && (
        <span className="text-[10px] text-token-muted">
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
      className={`inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[11px] transition-colors ${
        active ? 'surface-action-accent' : 'surface-action hover:text-token-primary'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
