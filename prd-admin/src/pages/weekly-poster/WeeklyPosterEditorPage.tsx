import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Save,
  Send,
  Image as ImageIcon,
  Wand2,
  Clock,
  CheckCircle2,
  FileText,
  ArrowLeft,
} from 'lucide-react';
import {
  listWeeklyPosters,
  createWeeklyPoster,
  updateWeeklyPoster,
  publishWeeklyPoster,
  unpublishWeeklyPoster,
  deleteWeeklyPoster,
  type WeeklyPoster,
  type WeeklyPosterPage,
} from '@/services';
import { apiRequest } from '@/services/real/apiClient';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

/** 计算当前 ISO 周标识 "YYYY-WXX" */
function currentWeekKey(): string {
  const now = new Date();
  // ISO week calculation
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

const DEFAULT_ACCENT = '#7c3aed';

function emptyPage(order: number): WeeklyPosterPage {
  return {
    order,
    title: '',
    body: '',
    imagePrompt: '',
    imageUrl: null,
    accentColor: DEFAULT_ACCENT,
  };
}

export default function WeeklyPosterEditorPage() {
  const [items, setItems] = useState<WeeklyPoster[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<WeeklyPoster | null>(null);
  const [draft, setDraft] = useState<WeeklyPoster | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await listWeeklyPosters({ pageSize: 50 });
    if (res.success && res.data) {
      setItems(res.data.items);
    } else {
      toast.error(res.error?.message || '加载失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSelect = (poster: WeeklyPoster) => {
    setSelected(poster);
    setDraft(JSON.parse(JSON.stringify(poster)) as WeeklyPoster);
  };

  const handleCreate = async () => {
    const input = {
      weekKey: currentWeekKey(),
      title: `${currentWeekKey()} 平台更新速览`,
      subtitle: '',
      ctaText: '阅读完整周报',
      ctaUrl: '/changelog',
      pages: [
        { ...emptyPage(0), title: '本周亮点', body: '用一句话概括本周最重要的更新。' },
        { ...emptyPage(1), title: '新功能', body: '列出 2-3 个用户最关心的新功能。' },
        { ...emptyPage(2), title: '修复 & 优化', body: '挑选 3-5 条影响最大的修复和性能优化。' },
        { ...emptyPage(3), title: '下周预告', body: '提前告诉用户下周会上线什么,制造期待。' },
      ],
    };
    const res = await createWeeklyPoster(input);
    if (res.success && res.data) {
      toast.success('已创建草稿');
      await refresh();
      handleSelect(res.data);
    } else {
      toast.error(res.error?.message || '创建失败');
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    const res = await updateWeeklyPoster(draft.id, {
      weekKey: draft.weekKey,
      title: draft.title,
      subtitle: draft.subtitle ?? '',
      pages: draft.pages,
      ctaText: draft.ctaText,
      ctaUrl: draft.ctaUrl,
    });
    setSaving(false);
    if (res.success && res.data) {
      toast.success('已保存');
      await refresh();
      setSelected(res.data);
      setDraft(JSON.parse(JSON.stringify(res.data)) as WeeklyPoster);
    } else {
      toast.error(res.error?.message || '保存失败');
    }
  };

  const handlePublish = async () => {
    if (!draft) return;
    // 先保存,再发布
    await handleSave();
    const res = await publishWeeklyPoster(draft.id);
    if (res.success && res.data) {
      toast.success('已发布,登录用户首次访问主页即可看到');
      await refresh();
      setSelected(res.data);
      setDraft(JSON.parse(JSON.stringify(res.data)) as WeeklyPoster);
    } else {
      toast.error(res.error?.message || '发布失败');
    }
  };

  const handleUnpublish = async () => {
    if (!draft) return;
    const res = await unpublishWeeklyPoster(draft.id);
    if (res.success) {
      toast.success('已撤回为草稿');
      await refresh();
      setSelected({ ...draft, status: 'draft' });
      setDraft({ ...draft, status: 'draft' });
    } else {
      toast.error(res.error?.message || '撤回失败');
    }
  };

  const handleDelete = async () => {
    if (!draft) return;
    if (!window.confirm('确定删除这张海报?此操作不可撤销。')) return;
    const res = await deleteWeeklyPoster(draft.id);
    if (res.success) {
      toast.success('已删除');
      setSelected(null);
      setDraft(null);
      await refresh();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const handlePageChange = (order: number, patch: Partial<WeeklyPosterPage>) => {
    if (!draft) return;
    const nextPages = draft.pages.map((p) => (p.order === order ? { ...p, ...patch } : p));
    setDraft({ ...draft, pages: nextPages });
  };

  const handleAddPage = () => {
    if (!draft) return;
    const nextOrder = draft.pages.length;
    setDraft({ ...draft, pages: [...draft.pages, emptyPage(nextOrder)] });
  };

  const handleRemovePage = (order: number) => {
    if (!draft) return;
    const nextPages = draft.pages
      .filter((p) => p.order !== order)
      .map((p, i) => ({ ...p, order: i }));
    setDraft({ ...draft, pages: nextPages });
  };

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* Header */}
      <div
        className="shrink-0 px-6 py-4 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-3">
          <Link
            to="/weekly-poster"
            aria-label="返回工坊"
            className="inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-[12px] transition-colors"
            style={{
              color: 'rgba(255,255,255,0.75)',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <ArrowLeft size={12} /> 返回工坊
          </Link>
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-white/45 mb-0.5">
              Homepage · Poster
            </div>
            <h1 className="text-[18px] font-semibold text-white">海报编辑器 · 高级模式</h1>
            <div className="text-[12px] mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
              对已有海报做手动微调;新建走 <Link to="/weekly-poster" className="underline hover:text-white">AI 工坊</Link> 更顺手。
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 px-4 h-9 rounded-full text-[13px] font-medium text-white transition-all hover:scale-[1.02]"
          style={{
            background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
            boxShadow: '0 4px 16px rgba(124,58,237,0.3)',
          }}
        >
          <Plus size={14} />
          新建海报
        </button>
      </div>

      {/* Body: left list + right editor */}
      <div className="flex-1 min-h-0 flex">
        {/* List */}
        <aside
          className="shrink-0 w-[280px] flex flex-col"
          style={{ borderRight: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div
            className="flex-1 min-h-0 overflow-y-auto"
            style={{ overscrollBehavior: 'contain' }}
          >
            {loading ? (
              <MapSectionLoader text="加载中..." />
            ) : items.length === 0 ? (
              <div
                className="px-4 py-8 text-center text-[12px]"
                style={{ color: 'rgba(255,255,255,0.45)' }}
              >
                暂无海报。点击右上角「新建海报」开始。
              </div>
            ) : (
              <ul className="px-2 py-2 space-y-1">
                {items.map((item) => {
                  const active = selected?.id === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => handleSelect(item)}
                        className="w-full text-left px-3 py-2.5 rounded-lg transition-colors"
                        style={{
                          background: active ? 'rgba(124,58,237,0.18)' : 'transparent',
                          border: active
                            ? '1px solid rgba(124,58,237,0.4)'
                            : '1px solid transparent',
                        }}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wide uppercase"
                            style={{
                              background:
                                item.status === 'published'
                                  ? 'rgba(34,197,94,0.18)'
                                  : item.status === 'archived'
                                    ? 'rgba(100,116,139,0.2)'
                                    : 'rgba(251,191,36,0.2)',
                              color:
                                item.status === 'published'
                                  ? '#86efac'
                                  : item.status === 'archived'
                                    ? '#94a3b8'
                                    : '#fde68a',
                            }}
                          >
                            {item.status === 'published'
                              ? '已发布'
                              : item.status === 'archived'
                                ? '已归档'
                                : '草稿'}
                          </span>
                          <span className="text-[11px] text-white/50">{item.weekKey}</span>
                        </div>
                        <div className="text-[13px] font-medium text-white truncate">
                          {item.title || '未命名海报'}
                        </div>
                        <div className="text-[11px] text-white/40 mt-0.5">
                          {item.pages?.length ?? 0} 页
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Editor */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col">
          {!draft ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <FileText size={32} className="mx-auto mb-2 text-white/20" />
                <div className="text-[14px] text-white/50">选择左侧海报编辑,或新建一张</div>
              </div>
            </div>
          ) : (
            <>
              {/* Editor top bar */}
              <div
                className="shrink-0 px-6 py-3 flex items-center justify-between gap-4 flex-wrap"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-1.5 text-[11px] text-white/50">
                    <Clock size={12} />
                    <span>
                      状态:
                      <span className="text-white/80 ml-1">
                        {draft.status === 'published'
                          ? '已发布'
                          : draft.status === 'archived'
                            ? '已归档'
                            : '草稿'}
                      </span>
                    </span>
                  </div>
                  {draft.publishedAt && (
                    <div className="text-[11px] text-white/40">
                      发布时间:{new Date(draft.publishedAt).toLocaleString('zh-CN')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-rose-500/15"
                    style={{
                      color: '#fda4af',
                      border: '1px solid rgba(244,63,94,0.3)',
                    }}
                  >
                    <Trash2 size={12} />
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
                    style={{
                      color: 'rgba(255,255,255,0.85)',
                      border: '1px solid rgba(255,255,255,0.18)',
                    }}
                  >
                    {saving ? <MapSpinner size={12} /> : <Save size={12} />}
                    保存草稿
                  </button>
                  {draft.status === 'published' ? (
                    <button
                      type="button"
                      onClick={handleUnpublish}
                      className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-slate-500/15"
                      style={{
                        color: '#cbd5e1',
                        border: '1px solid rgba(148,163,184,0.3)',
                      }}
                    >
                      <Clock size={12} />
                      撤回为草稿
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handlePublish}
                      className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] font-medium text-white transition-all hover:scale-[1.03]"
                      style={{
                        background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
                        boxShadow: '0 4px 14px rgba(124,58,237,0.3)',
                      }}
                    >
                      <Send size={12} />
                      发布到主页
                    </button>
                  )}
                </div>
              </div>

              {/* Editor body */}
              <div
                className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5"
                style={{ overscrollBehavior: 'contain' }}
              >
                {/* Meta */}
                <div
                  className="rounded-xl p-4 space-y-3"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledInput
                      label="周标识"
                      placeholder="2026-W17"
                      value={draft.weekKey}
                      onChange={(v) => setDraft({ ...draft, weekKey: v })}
                    />
                    <LabeledInput
                      label="海报标题"
                      placeholder="2026-W17 平台更新速览"
                      value={draft.title}
                      onChange={(v) => setDraft({ ...draft, title: v })}
                    />
                  </div>
                  <LabeledInput
                    label="副标题(可选)"
                    placeholder="本周我们上线了 3 个大功能 + 修复了 12 个问题"
                    value={draft.subtitle ?? ''}
                    onChange={(v) => setDraft({ ...draft, subtitle: v })}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledInput
                      label="末页 CTA 按钮"
                      placeholder="阅读完整周报"
                      value={draft.ctaText}
                      onChange={(v) => setDraft({ ...draft, ctaText: v })}
                    />
                    <LabeledInput
                      label="末页跳转路径"
                      placeholder="/changelog"
                      value={draft.ctaUrl}
                      onChange={(v) => setDraft({ ...draft, ctaUrl: v })}
                    />
                  </div>
                </div>

                {/* Pages */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-semibold text-white/85 tracking-wide">
                      轮播页面 · {draft.pages.length} 页
                    </h3>
                    <button
                      type="button"
                      onClick={handleAddPage}
                      className="inline-flex items-center gap-1 px-2.5 h-7 rounded-md text-[11px] transition-colors hover:bg-white/10"
                      style={{
                        color: 'rgba(255,255,255,0.85)',
                        border: '1px solid rgba(255,255,255,0.15)',
                      }}
                    >
                      <Plus size={11} /> 增加一页
                    </button>
                  </div>
                  {draft.pages
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((page) => (
                      <PageEditor
                        key={page.order}
                        page={page}
                        onChange={(patch) => handlePageChange(page.order, patch)}
                        onRemove={() => handleRemovePage(page.order)}
                        canRemove={draft.pages.length > 1}
                      />
                    ))}
                </div>

                <div
                  className="rounded-xl p-3 text-[12px] flex items-start gap-2"
                  style={{
                    background: 'rgba(124,58,237,0.08)',
                    border: '1px solid rgba(124,58,237,0.22)',
                    color: 'rgba(255,255,255,0.7)',
                  }}
                >
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-indigo-300" />
                  <div>
                    每页「配图提示词」由 AI 帮你写好,点击紫色「生成图片」按钮就会直接调用平台
                    默认文生图模型出图(大约 10-30 秒),生成后图片会自动填回。不满意可以改提示词后重新生成。
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium text-white/55 mb-1">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-9 px-3 rounded-md text-[13px] outline-none transition-colors"
        style={{
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'rgba(255,255,255,0.9)',
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.6)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)')}
      />
    </label>
  );
}

interface GenerateImageApiResult {
  images: Array<{ url?: string | null; base64?: string | null }>;
}

function PageEditor({
  page,
  onChange,
  onRemove,
  canRemove,
}: {
  page: WeeklyPosterPage;
  onChange: (patch: Partial<WeeklyPosterPage>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    const prompt = page.imagePrompt.trim();
    if (!prompt) {
      toast.error('先填写配图提示词');
      return;
    }
    setGenerating(true);
    try {
      // 调用平台默认文生图:/api/visual-agent/image-gen/generate
      // responseFormat=url 优先拿直链;失败兜底到 base64 data URI(多数模型都支持 url)
      const res = await apiRequest<GenerateImageApiResult>(
        '/api/visual-agent/image-gen/generate',
        {
          method: 'POST',
          body: {
            prompt,
            n: 1,
            size: '1024x1024',
            responseFormat: 'url',
          },
        }
      );
      if (!res.success || !res.data) {
        toast.error(res.error?.message || '生图失败,请检查提示词或稍后重试');
        return;
      }
      const first = res.data.images?.[0];
      if (!first) {
        toast.error('生图模型未返回图片');
        return;
      }
      const url = first.url
        ? first.url
        : first.base64
          ? `data:image/png;base64,${first.base64}`
          : null;
      if (!url) {
        toast.error('生图结果无法解析');
        return;
      }
      onChange({ imageUrl: url });
      toast.success('已生成,记得点右上角「保存草稿」');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生图失败');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold text-white/75">
          第 {page.order + 1} 页
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          className="inline-flex items-center gap-1 px-2 h-6 rounded text-[10px] transition-colors disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-rose-500/15"
          style={{ color: '#fda4af' }}
        >
          <Trash2 size={10} /> 删除本页
        </button>
      </div>
      <LabeledInput
        label="页面标题"
        value={page.title}
        onChange={(v) => onChange({ title: v })}
        placeholder="本周亮点"
      />
      <label className="block">
        <div className="text-[11px] font-medium text-white/55 mb-1">正文</div>
        <textarea
          value={page.body}
          onChange={(e) => onChange({ body: e.target.value })}
          rows={3}
          placeholder="用几句话讲清楚这一页要告诉用户什么"
          className="w-full px-3 py-2 rounded-md text-[13px] outline-none transition-colors resize-y"
          style={{
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.9)',
            minHeight: 72,
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.6)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)')}
        />
      </label>
      <label className="block">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[11px] font-medium text-white/55 inline-flex items-center gap-1">
            <ImageIcon size={11} />
            配图提示词(AI 自动生成,可直接编辑)
          </div>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-[11px] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:scale-[1.03]"
            style={{
              background: generating
                ? 'rgba(124,58,237,0.35)'
                : 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
              color: '#fff',
              boxShadow: generating ? 'none' : '0 3px 12px rgba(124,58,237,0.4)',
            }}
          >
            {generating ? (
              <>
                <MapSpinner size={11} /> 生成中,约 10-30 秒
              </>
            ) : (
              <>
                <Wand2 size={11} /> {page.imageUrl ? '重新生成' : '生成图片'}
              </>
            )}
          </button>
        </div>
        <textarea
          value={page.imagePrompt}
          onChange={(e) => onChange({ imagePrompt: e.target.value })}
          rows={2}
          placeholder="A cinematic isometric illustration of a glowing control panel with multiple agents..."
          className="w-full px-3 py-2 rounded-md text-[12px] outline-none transition-colors font-mono resize-y"
          style={{
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.85)',
            minHeight: 60,
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.6)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)')}
        />
      </label>

      {/* 配图预览 + 主色调 */}
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 rounded-md overflow-hidden relative"
          style={{
            width: 140,
            height: 88,
            background: page.imageUrl
              ? undefined
              : `linear-gradient(135deg, ${page.accentColor || DEFAULT_ACCENT}, #0a0a12)`,
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          {page.imageUrl ? (
            <img
              src={page.imageUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/50">
              未生成
            </div>
          )}
          {page.imageUrl && (
            <button
              type="button"
              onClick={() => onChange({ imageUrl: null })}
              className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-[10px] transition-colors hover:bg-rose-500/40"
              style={{
                background: 'rgba(0,0,0,0.6)',
                color: '#fda4af',
              }}
              aria-label="清除图片"
              title="清除"
            >
              ×
            </button>
          )}
        </div>
        <label className="block flex-1 min-w-0">
          <div className="text-[11px] font-medium text-white/55 mb-1">主色调(无图时的兜底渐变)</div>
          <input
            type="color"
            value={page.accentColor || DEFAULT_ACCENT}
            onChange={(e) => onChange({ accentColor: e.target.value })}
            className="w-full h-9 rounded-md cursor-pointer"
            style={{
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          />
        </label>
      </div>
    </div>
  );
}
