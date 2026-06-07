import { useState, useRef, useCallback, useEffect } from 'react';
import { FileText, Upload, BookOpen, Presentation, Globe, Plus, Trash2, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  streamMdToPptConvert,
  buildRevealHtml,
  publishMdToPpt,
  type PptSlide,
} from '@/services/real/mdToPptService';
import { listMyTeams, type TeamListItem } from '@/services/real/teams';
// ============ Reveal.js themes ============
const REVEAL_THEMES = [
  { value: 'black', label: '深色' },
  { value: 'white', label: '浅色' },
  { value: 'league', label: '联盟' },
  { value: 'beige', label: '米色' },
  { value: 'sky', label: '天空蓝' },
  { value: 'night', label: '夜晚' },
  { value: 'serif', label: '衬线' },
  { value: 'simple', label: '简约' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'moon', label: '月亮' },
  { value: 'dracula', label: 'Dracula' },
];

// ============ SlideCard ============
interface SlideCardProps {
  slide: PptSlide;
  index: number;
  onUpdate: (index: number, updated: PptSlide) => void;
  onDelete: (index: number) => void;
}

function SlideCard({ slide, index, onUpdate, onDelete }: SlideCardProps) {
  const [expanded, setExpanded] = useState(true);

  function handleTitleChange(val: string) {
    onUpdate(index, { ...slide, title: val });
  }

  function handleBulletChange(bi: number, val: string) {
    const bullets = [...slide.bullets];
    bullets[bi] = val;
    onUpdate(index, { ...slide, bullets });
  }

  function handleAddBullet() {
    onUpdate(index, { ...slide, bullets: [...slide.bullets, ''] });
  }

  function handleDeleteBullet(bi: number) {
    const bullets = slide.bullets.filter((_, i) => i !== bi);
    onUpdate(index, { ...slide, bullets });
  }

  return (
    <div className="border border-white/10 rounded-lg bg-[var(--bg-card)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2 cursor-pointer select-none hover:bg-white/5"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-xs text-white/40 font-mono shrink-0 w-6">
          {String(index + 1).padStart(2, '0')}
        </span>
        <input
          className="flex-1 bg-transparent text-sm font-medium text-white/90 outline-none min-w-0"
          value={slide.title}
          onChange={(e) => handleTitleChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="幻灯片标题"
        />
        <button
          className="p-1 rounded hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-colors shrink-0"
          onClick={(e) => { e.stopPropagation(); onDelete(index); }}
          title="删除此页"
        >
          <Trash2 size={13} />
        </button>
        <span className="text-white/30 shrink-0">
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </div>
      {expanded && (
        <div className="px-4 pb-3 flex flex-col gap-1 border-t border-white/5">
          {slide.bullets.map((bullet, bi) => (
            <div key={bi} className="flex items-center gap-1 mt-1">
              <span className="text-white/20 text-xs shrink-0">-</span>
              <input
                className="flex-1 bg-transparent text-sm text-white/70 outline-none min-w-0 py-0.5"
                value={bullet}
                onChange={(e) => handleBulletChange(bi, e.target.value)}
                placeholder="要点"
              />
              <button
                className="p-0.5 rounded hover:bg-red-500/20 text-white/20 hover:text-red-400 transition-colors shrink-0"
                onClick={() => handleDeleteBullet(bi)}
                title="删除此要点"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <button
            className="mt-1 text-xs text-white/30 hover:text-white/60 flex items-center gap-1 w-fit transition-colors"
            onClick={handleAddBullet}
          >
            <Plus size={11} /> 添加要点
          </button>
        </div>
      )}
    </div>
  );
}

// ============ Main page ============
export function MdToPptAgentPage() {
  // Input state
  const [inputTab, setInputTab] = useState<'text' | 'file' | 'kb'>('text');
  const [markdownText, setMarkdownText] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedText, setUploadedText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Generation state
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [modelInfo, setModelInfo] = useState<{ model: string; platform: string } | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);

  // Slides state
  const [slides, setSlides] = useState<PptSlide[]>([]);
  const [selectedTheme, setSelectedTheme] = useState('black');
  const [pptTitle, setPptTitle] = useState('');

  // Preview state（客户端即时渲染，无需 rendering loading 态）
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [, setPreviewSlideIndex] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Publish state
  const [publishing, setPublishing] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  // 团队选择（发布到网页托管时可选择分享团队）
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);

  // Error
  const [error, setError] = useState<string | null>(null);

  // ── File upload handling ──────────────────────────────────

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    // Read as text (plain text / markdown files)
    const text = await file.text();
    setUploadedText(text);
  }

  // ── Compute effective content ─────────────────────────────

  function getEffectiveContent(): string {
    if (inputTab === 'text') return markdownText;
    if (inputTab === 'file') return uploadedText;
    return '';
  }

  // ── Convert (SSE) ─────────────────────────────────────────

  const handleConvert = useCallback(() => {
    const content = getEffectiveContent().trim();
    if (!content) {
      setError('请先输入或上传内容');
      return;
    }
    setError(null);
    setStreaming(true);
    setStreamText('');
    setModelInfo(null);
    setSlides([]);
    setPreviewHtml(null);
    setPublishedUrl(null);
    setPublishError(null);

    const stop = streamMdToPptConvert({
      content,
      onStart: () => {
        setStreamText('');
      },
      onModel: (info) => {
        setModelInfo(info);
      },
      onDelta: (text) => {
        setStreamText((prev) => prev + text);
      },
      onDone: (result) => {
        setStreaming(false);
        setSlides(result.slides);
        stopStreamRef.current = null;
      },
      onError: (msg) => {
        setStreaming(false);
        setError(msg);
        stopStreamRef.current = null;
      },
    });
    stopStreamRef.current = stop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputTab, markdownText, uploadedText]);

  function handleStopStream() {
    stopStreamRef.current?.();
    stopStreamRef.current = null;
    setStreaming(false);
  }

  // ── Slide editing ─────────────────────────────────────────

  function handleUpdateSlide(index: number, updated: PptSlide) {
    setSlides((prev) => {
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  }

  function handleDeleteSlide(index: number) {
    setSlides((prev) => prev.filter((_, i) => i !== index));
  }

  function handleAddSlide() {
    setSlides((prev) => [...prev, { title: '新幻灯片', bullets: [''] }]);
  }

  // ── Render preview ────────────────────────────────────────

  function handleRenderPreview() {
    if (slides.length === 0) return;
    // 客户端直接渲染 reveal.js HTML(纯确定性转换),不再走 /render 后端往返:
    // 即时预览、随编辑实时更新、不受代理层/网络影响。
    setPreviewHtml(buildRevealHtml(slides, selectedTheme, pptTitle || undefined));
    setPreviewSlideIndex(0);
  }

  // Auto-render when slides or theme change（客户端即时渲染）
  useEffect(() => {
    if (slides.length > 0 && !streaming) {
      handleRenderPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, selectedTheme, pptTitle]);

  // 加载我的团队（发布时可选分享团队）
  useEffect(() => {
    void (async () => {
      const res = await listMyTeams();
      if (res.success && res.data?.items) setTeams(res.data.items);
    })();
  }, []);

  // ── Publish ───────────────────────────────────────────────

  async function handlePublish() {
    if (slides.length === 0) return;
    setPublishing(true);
    setPublishError(null);
    const result = await publishMdToPpt({
      htmlContent: buildRevealHtml(slides, selectedTheme, pptTitle || undefined),
      title: pptTitle || undefined,
      teamIds: selectedTeamIds.length > 0 ? selectedTeamIds : undefined,
    });
    setPublishing(false);
    if (result.success && result.siteUrl) {
      setPublishedUrl(result.siteUrl);
    } else {
      setPublishError(result.error ?? '发布失败');
    }
  }

  // ── Render ────────────────────────────────────────────────

  const hasContent = getEffectiveContent().trim().length > 0;
  const hasSlides = slides.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-white/8 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Presentation size={20} className="text-[var(--color-primary,#a855f7)]" />
          <h1 className="text-base font-semibold text-white/90">Markdown 转网页 PPT</h1>
        </div>
        <span className="text-xs text-white/30">
          粘贴 Markdown / 上传文件，AI 生成可分享的演示幻灯片
        </span>
        {modelInfo && (
          <span className="ml-auto text-[11px] text-white/30 font-mono">
            {modelInfo.model} · {modelInfo.platform}
          </span>
        )}
      </div>

      {/* Main split layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel: input + slides editor */}
        <div
          className="flex flex-col shrink-0 border-r border-white/8"
          style={{ width: 380, minHeight: 0 }}
        >
          {/* Input tabs */}
          <div className="shrink-0 px-4 pt-3 pb-0">
            <div className="flex gap-1 mb-3 border-b border-white/8">
              {([
                { key: 'text', label: '粘贴文本', icon: FileText },
                { key: 'file', label: '上传文件', icon: Upload },
                { key: 'kb', label: '知识库', icon: BookOpen },
              ] as const).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setInputTab(key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t transition-colors ${
                    inputTab === key
                      ? 'text-white/90 border-b-2 border-[var(--color-primary,#a855f7)]'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                >
                  <Icon size={12} />
                  {label}
                </button>
              ))}
            </div>

            {/* Text input */}
            {inputTab === 'text' && (
              <textarea
                className="w-full rounded-lg border border-white/10 bg-[var(--bg-input)] text-sm text-white/80 px-3 py-2 outline-none resize-none placeholder:text-white/25"
                style={{ height: 180, minHeight: 0 }}
                placeholder={'粘贴 Markdown 或纯文本...\n\n# 标题\n\n## 第一章\n- 要点一\n- 要点二\n\n## 第二章\n- 要点三'}
                value={markdownText}
                onChange={(e) => setMarkdownText(e.target.value)}
              />
            )}

            {/* File upload */}
            {inputTab === 'file' && (
              <div className="flex flex-col gap-2">
                <div
                  className="border-2 border-dashed border-white/15 rounded-lg px-4 py-6 text-center cursor-pointer hover:border-white/25 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files[0];
                    if (file) {
                      const fakeEvent = { target: { files: [file] } } as unknown as React.ChangeEvent<HTMLInputElement>;
                      void handleFileUpload(fakeEvent);
                    }
                  }}
                >
                  <Upload size={24} className="mx-auto mb-2 text-white/25" />
                  {uploadedFileName ? (
                    <p className="text-sm text-white/70">{uploadedFileName}</p>
                  ) : (
                    <>
                      <p className="text-sm text-white/50">点击或拖拽文件到此处</p>
                      <p className="text-xs text-white/25 mt-1">支持 .md / .txt / .csv 等纯文本格式</p>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt,.csv,.text"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>
            )}

            {/* Knowledge base placeholder */}
            {inputTab === 'kb' && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <BookOpen size={32} className="text-white/20 mb-2" />
                <p className="text-sm text-white/40">从知识库选取文章</p>
                <p className="text-xs text-white/20 mt-1">功能开发中，敬请期待</p>
              </div>
            )}

            {/* Generate button */}
            <div className="flex items-center gap-2 mt-3">
              <button
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors
                  bg-[var(--color-primary,#a855f7)] hover:opacity-90 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!hasContent || streaming}
                onClick={handleConvert}
              >
                {streaming ? (
                  <>
                    <MapSpinner size={14} />
                    生成中...
                  </>
                ) : (
                  <>
                    <Presentation size={14} />
                    生成 PPT 大纲
                  </>
                )}
              </button>
              {streaming && (
                <button
                  className="px-3 py-2 rounded-lg text-sm text-white/50 hover:text-white/80 border border-white/10 hover:border-white/20 transition-colors"
                  onClick={handleStopStream}
                >
                  停止
                </button>
              )}
            </div>

            {error && (
              <p className="mt-2 text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">{error}</p>
            )}
          </div>

          {/* Streaming text preview */}
          {streaming && streamText && (
            <div
              className="mx-4 mt-2 shrink-0 rounded border border-white/8 bg-[var(--bg-base)] px-3 py-2 text-xs text-white/50 font-mono overflow-hidden"
              style={{ maxHeight: 80, overflowY: 'hidden' }}
            >
              {streamText.slice(-300)}
            </div>
          )}

          {/* Slides editor */}
          {hasSlides && (
            <div
              className="flex flex-col flex-1 min-h-0 mt-3 px-4 pb-2"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
            >
              <div className="shrink-0 flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-white/50">
                  幻灯片编辑 ({slides.length} 页)
                </span>
                <button
                  className="text-xs text-white/30 hover:text-white/60 flex items-center gap-1 transition-colors"
                  onClick={handleAddSlide}
                >
                  <Plus size={11} /> 添加页
                </button>
              </div>
              <div className="flex flex-col gap-2">
                {slides.map((slide, i) => (
                  <SlideCard
                    key={i}
                    slide={slide}
                    index={i}
                    onUpdate={handleUpdateSlide}
                    onDelete={handleDeleteSlide}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Options & Publish panel */}
          {hasSlides && (
            <div className="shrink-0 px-4 pb-4 pt-2 border-t border-white/8 flex flex-col gap-2">
              {/* Title */}
              <input
                className="w-full rounded border border-white/10 bg-[var(--bg-input)] text-sm text-white/80 px-2 py-1.5 outline-none placeholder:text-white/25"
                placeholder="演示标题（可选）"
                value={pptTitle}
                onChange={(e) => setPptTitle(e.target.value)}
              />
              {/* Theme picker */}
              <select
                className="w-full rounded border border-white/10 bg-[var(--bg-input)] text-sm text-white/70 px-2 py-1.5 outline-none"
                value={selectedTheme}
                onChange={(e) => setSelectedTheme(e.target.value)}
              >
                {REVEAL_THEMES.map((t) => (
                  <option key={t.value} value={t.value}>
                    主题：{t.label}
                  </option>
                ))}
              </select>
              {/* 分享到团队（可选，转存网页托管时一并设置） */}
              {teams.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-white/40">分享到团队（可选）</span>
                  <div className="flex flex-wrap gap-1.5">
                    {teams.map((t) => {
                      const on = selectedTeamIds.includes(t.team.id);
                      return (
                        <button
                          key={t.team.id}
                          type="button"
                          onClick={() => setSelectedTeamIds((prev) => (on ? prev.filter((x) => x !== t.team.id) : [...prev, t.team.id]))}
                          className="px-2.5 py-1 rounded-md text-xs transition-colors"
                          style={on
                            ? { background: 'rgba(16,185,129,0.18)', color: 'rgba(167,243,208,0.95)', border: '1px solid rgba(16,185,129,0.4)' }
                            : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
                        >
                          {t.team.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Publish button */}
              <button
                className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors
                  bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!hasSlides || publishing}
                onClick={handlePublish}
              >
                {publishing ? (
                  <>
                    <MapSpinner size={14} />
                    发布中...
                  </>
                ) : (
                  <>
                    <Globe size={14} />
                    一键发布到网页托管
                  </>
                )}
              </button>
              {publishedUrl && (
                <a
                  href={publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors truncate"
                >
                  <ExternalLink size={12} />
                  {publishedUrl}
                </a>
              )}
              {publishError && (
                <p className="text-xs text-red-400">{publishError}</p>
              )}
            </div>
          )}
        </div>

        {/* Right panel: preview */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Preview header */}
          {hasSlides && (
            <div className="shrink-0 px-4 py-2 border-b border-white/8 flex items-center gap-2">
              <span className="text-xs text-white/40">预览</span>
              {slides.length > 0 && (
                <span className="text-xs text-white/25 ml-auto">
                  {slides.length} 页 · {REVEAL_THEMES.find((t) => t.value === selectedTheme)?.label ?? selectedTheme} 主题
                </span>
              )}
            </div>
          )}

          {/* Empty state */}
          {!hasSlides && !streaming && (
            <div className="flex flex-col items-center justify-center flex-1 text-center px-8">
              <Presentation size={48} className="text-white/10 mb-4" />
              <p className="text-base font-medium text-white/40">还没有幻灯片</p>
              <p className="text-sm text-white/25 mt-1">
                在左侧输入 Markdown 或上传文件，点击「生成 PPT 大纲」开始
              </p>
            </div>
          )}

          {/* Streaming empty state */}
          {streaming && !previewHtml && (
            <div className="flex flex-col items-center justify-center flex-1 gap-3">
              <MapSectionLoader text="AI 正在生成 PPT 大纲..." />
            </div>
          )}

          {/* Reveal.js preview iframe */}
          {previewHtml && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden p-3">
              <iframe
                ref={iframeRef}
                srcDoc={previewHtml}
                className="flex-1 min-h-0 w-full rounded-lg border border-white/10"
                style={{ minHeight: 0 }}
                title="PPT 预览"
                sandbox="allow-scripts allow-same-origin"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
