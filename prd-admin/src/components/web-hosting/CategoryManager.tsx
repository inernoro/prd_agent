import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Pencil, Trash2, Sparkles, FolderTree, ExternalLink, ArrowLeft } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listWebCategories,
  createWebCategory,
  updateWebCategory,
  deleteWebCategory,
  generateFromCategory,
  type WebCategory,
  type WebCategoryInput,
  type WebCategoryGeneratorType,
  type WebCategoryGenerateTarget,
  type GenerateResult,
} from '@/services/real/webCategories';

/**
 * 自定义分类管理器 —— 列出/新建/编辑/删除分类，并对绑定了 Markdown 生成器的分类
 * 一键「按分类生成」托管网页或知识库条目。
 *
 * 遵循 frontend-modal 规则：createPortal 挂 body、inline style 高度、min-h-0 滚动区、
 * overscrollBehavior:contain、ESC + 蒙版点击关闭、z-[10000]。
 * 主题：面板/下拉用不透明 token var(--bg-elevated)（不要用 var(--bg-card) 半透明玻璃），
 * 文字走 var(--text-primary/secondary)，两套主题自动翻转。
 */

interface CategoryManagerProps {
  onClose: () => void;
  onGenerated?: () => void;
}

type ViewMode =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; category: WebCategory };

const EMPTY_FORM: WebCategoryInput = {
  name: '',
  description: '',
  sortOrder: 0,
  generatorType: 'none',
  generatorSkillId: '',
  generatorMarkdown: '',
  generateTarget: 'web',
  generateStoreId: '',
};

const SURFACE = 'var(--bg-elevated)';
const BORDER = 'var(--border-subtle, rgba(127,127,127,0.18))';
const TEXT = 'var(--text-primary)';
const TEXT_SUB = 'var(--text-secondary)';

function fieldStyle(): React.CSSProperties {
  return {
    background: SURFACE,
    borderColor: BORDER,
    color: TEXT,
  };
}

export function CategoryManager({ onClose, onGenerated }: CategoryManagerProps) {
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<WebCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>({ kind: 'list' });

  // 编辑/创建表单
  const [form, setForm] = useState<WebCategoryInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 生成状态
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [generateMsg, setGenerateMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listWebCategories();
    if (res.success) {
      setCategories(res.data.items ?? []);
    } else {
      setError(res.error?.message ?? '加载分类失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setView({ kind: 'create' });
  };

  const openEdit = (c: WebCategory) => {
    setForm({
      name: c.name,
      description: c.description ?? '',
      sortOrder: c.sortOrder,
      generatorType: c.generatorType,
      generatorSkillId: c.generatorSkillId ?? '',
      generatorMarkdown: c.generatorMarkdown ?? '',
      generateTarget: c.generateTarget,
      generateStoreId: c.generateStoreId ?? '',
    });
    setFormError(null);
    setView({ kind: 'edit', category: c });
  };

  const backToList = () => {
    setView({ kind: 'list' });
    setFormError(null);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setFormError('分类名称不能为空');
      return;
    }
    if (
      form.generatorType === 'markdown' &&
      !(form.generatorMarkdown ?? '').trim()
    ) {
      setFormError('生成器类型为 Markdown 时，模板内容不能为空');
      return;
    }
    if (
      form.generateTarget === 'document-store' &&
      !(form.generateStoreId ?? '').trim()
    ) {
      setFormError('生成目标为知识库时，需填写知识库空间 ID');
      return;
    }

    setSaving(true);
    setFormError(null);
    const payload: WebCategoryInput = {
      name: form.name.trim(),
      description: form.description?.trim() || undefined,
      sortOrder: form.sortOrder ?? 0,
      generatorType: form.generatorType,
      generatorSkillId: form.generatorSkillId?.trim() || undefined,
      generatorMarkdown: form.generatorMarkdown ?? undefined,
      generateTarget: form.generateTarget,
      generateStoreId: form.generateStoreId?.trim() || undefined,
    };

    const res =
      view.kind === 'edit'
        ? await updateWebCategory(view.category.id, payload)
        : await createWebCategory(payload);

    setSaving(false);
    if (res.success) {
      await load();
      backToList();
    } else {
      setFormError(res.error?.message ?? '保存失败');
    }
  };

  const handleDelete = async (c: WebCategory) => {
    if (!window.confirm(`确定删除分类「${c.name}」吗？`)) return;
    const res = await deleteWebCategory(c.id);
    if (res.success) {
      await load();
    } else {
      setError(res.error?.message ?? '删除失败');
    }
  };

  const handleGenerate = async (c: WebCategory) => {
    setGeneratingId(c.id);
    setGenerateMsg(null);
    const res = await generateFromCategory(c.id);
    setGeneratingId(null);
    if (!res.success) {
      setGenerateMsg({ ok: false, text: res.error?.message ?? '生成失败' });
      return;
    }
    const data: GenerateResult = res.data;
    if (!data.generated) {
      setGenerateMsg({ ok: false, text: data.reason ?? '未生成内容' });
      return;
    }
    if (data.target === 'document-store') {
      setGenerateMsg({ ok: true, text: `已在知识库生成条目「${data.title ?? ''}」` });
    } else {
      setGenerateMsg({
        ok: true,
        text: `已生成托管网页「${data.title ?? ''}」`,
        url: data.siteUrl,
      });
    }
    onGenerated?.();
  };

  const generatorLabel = (t: WebCategoryGeneratorType): string =>
    t === 'markdown' ? 'Markdown 模板' : t === 'skill' ? 'Skill' : '仅分类';
  const targetLabel = (t: WebCategoryGenerateTarget): string =>
    t === 'document-store' ? '知识库' : '托管网页';

  // ─── 表单视图 ───
  const renderForm = () => (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: TEXT_SUB }}>
          分类名称 <span style={{ color: '#ef4444' }}>*</span>
        </span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="如：运营简报"
          className="rounded-lg border px-3 py-2 text-sm outline-none"
          style={fieldStyle()}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: TEXT_SUB }}>
          分类描述
        </span>
        <input
          type="text"
          value={form.description ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="可选"
          className="rounded-lg border px-3 py-2 text-sm outline-none"
          style={fieldStyle()}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: TEXT_SUB }}>
            生成器类型
          </span>
          <select
            value={form.generatorType}
            onChange={(e) =>
              setForm((f) => ({ ...f, generatorType: e.target.value as WebCategoryGeneratorType }))
            }
            className="rounded-lg border px-3 py-2 text-sm outline-none"
            style={fieldStyle()}
          >
            <option value="none">仅分类（不绑定生成器）</option>
            <option value="markdown">Markdown 模板</option>
            <option value="skill">Skill（暂仅即时支持 Markdown）</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: TEXT_SUB }}>
            排序权重
          </span>
          <input
            type="number"
            value={form.sortOrder ?? 0}
            onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))}
            className="rounded-lg border px-3 py-2 text-sm outline-none"
            style={fieldStyle()}
          />
        </label>
      </div>

      {form.generatorType === 'markdown' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: TEXT_SUB }}>
            Markdown 模板内容 <span style={{ color: '#ef4444' }}>*</span>
          </span>
          <textarea
            value={form.generatorMarkdown ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, generatorMarkdown: e.target.value }))}
            placeholder={'# 标题\n\n正文支持标准 Markdown 语法…'}
            rows={8}
            className="rounded-lg border px-3 py-2 text-sm outline-none font-mono"
            style={{ ...fieldStyle(), resize: 'vertical' }}
          />
        </label>
      )}

      {form.generatorType === 'skill' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: TEXT_SUB }}>
            绑定的 Skill ID
          </span>
          <input
            type="text"
            value={form.generatorSkillId ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, generatorSkillId: e.target.value }))}
            placeholder="skill 的 ID / Key"
            className="rounded-lg border px-3 py-2 text-sm outline-none"
            style={fieldStyle()}
          />
          <span className="text-[11px]" style={{ color: TEXT_SUB }}>
            提示：skill 生成需异步执行，当前一键生成仅即时支持 Markdown 模板。
          </span>
        </label>
      )}

      {form.generatorType !== 'none' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: TEXT_SUB }}>
              生成目标
            </span>
            <select
              value={form.generateTarget}
              onChange={(e) =>
                setForm((f) => ({ ...f, generateTarget: e.target.value as WebCategoryGenerateTarget }))
              }
              className="rounded-lg border px-3 py-2 text-sm outline-none"
              style={fieldStyle()}
            >
              <option value="web">托管网页</option>
              <option value="document-store">知识库条目</option>
            </select>
          </label>

          {form.generateTarget === 'document-store' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs" style={{ color: TEXT_SUB }}>
                知识库空间 ID <span style={{ color: '#ef4444' }}>*</span>
              </span>
              <input
                type="text"
                value={form.generateStoreId ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, generateStoreId: e.target.value }))}
                placeholder="document store ID"
                className="rounded-lg border px-3 py-2 text-sm outline-none"
                style={fieldStyle()}
              />
            </label>
          )}
        </div>
      )}

      {formError && (
        <div className="text-xs" style={{ color: '#ef4444' }}>
          {formError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={backToList}
          disabled={saving}
          className="rounded-lg border px-4 py-2 text-sm transition-colors hover:bg-black/5"
          style={{ borderColor: BORDER, color: TEXT_SUB }}
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60"
          style={{ background: 'var(--accent, #6366f1)' }}
        >
          {saving ? <MapSpinner size={14} /> : null}
          {view.kind === 'edit' ? '保存修改' : '创建分类'}
        </button>
      </div>
    </div>
  );

  // ─── 列表视图 ───
  const renderList = () => {
    if (loading) return <MapSectionLoader text="正在加载分类…" />;
    if (error)
      return (
        <div
          className="flex h-full items-center justify-center px-6 text-center text-sm"
          style={{ color: TEXT_SUB }}
        >
          {error}
        </div>
      );
    if (categories.length === 0)
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <FolderTree size={30} style={{ color: TEXT_SUB, opacity: 0.5 }} />
          <div className="text-sm" style={{ color: TEXT_SUB }}>
            还没有分类，点击下方「新建分类」开始
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ background: 'var(--accent, #6366f1)' }}
          >
            <Plus size={15} />
            新建分类
          </button>
        </div>
      );

    return (
      <ul className="flex flex-col gap-2">
        {categories.map((c) => {
          const canGenerate = c.generatorType === 'markdown';
          return (
            <li
              key={c.id}
              className="rounded-xl border px-4 py-3"
              style={{ borderColor: BORDER, background: SURFACE }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" style={{ color: TEXT }}>
                    {c.name}
                  </div>
                  {c.description && (
                    <div className="mt-0.5 truncate text-xs" style={{ color: TEXT_SUB }}>
                      {c.description}
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px]"
                      style={{ background: 'rgba(127,127,127,0.14)', color: TEXT_SUB }}
                    >
                      {generatorLabel(c.generatorType)}
                    </span>
                    {c.generatorType !== 'none' && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px]"
                        style={{ background: 'rgba(127,127,127,0.14)', color: TEXT_SUB }}
                      >
                        目标：{targetLabel(c.generateTarget)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleGenerate(c)}
                    disabled={!canGenerate || generatingId === c.id}
                    title={canGenerate ? '按分类生成' : '仅 Markdown 生成器支持一键生成'}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                    style={{ background: 'var(--accent, #6366f1)' }}
                  >
                    {generatingId === c.id ? <MapSpinner size={13} /> : <Sparkles size={13} />}
                    生成
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    title="编辑"
                    className="rounded-lg p-1.5 transition-colors hover:bg-black/10"
                    style={{ color: TEXT_SUB }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(c)}
                    title="删除"
                    className="rounded-lg p-1.5 transition-colors hover:bg-black/10"
                    style={{ color: TEXT_SUB }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  const isForm = view.kind === 'create' || view.kind === 'edit';

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col rounded-2xl border"
        style={{
          height: '82vh',
          maxHeight: '82vh',
          background: SURFACE,
          borderColor: BORDER,
          color: TEXT,
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: BORDER }}
        >
          <div className="flex items-center gap-2">
            {isForm && (
              <button
                type="button"
                onClick={backToList}
                className="rounded-lg p-1.5 transition-colors hover:bg-black/10"
                style={{ color: TEXT_SUB }}
                aria-label="返回"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <FolderTree size={16} style={{ color: TEXT_SUB }} />
            <span className="text-sm font-semibold">
              {view.kind === 'create'
                ? '新建分类'
                : view.kind === 'edit'
                  ? '编辑分类'
                  : '分类管理'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {view.kind === 'list' && categories.length > 0 && (
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                style={{ background: 'var(--accent, #6366f1)' }}
              >
                <Plus size={14} />
                新建
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 transition-colors hover:bg-black/10"
              style={{ color: TEXT_SUB }}
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 生成结果提示条（仅列表态显示） */}
        {view.kind === 'list' && generateMsg && (
          <div
            className="flex shrink-0 items-center gap-2 border-b px-5 py-2.5 text-xs"
            style={{
              borderColor: BORDER,
              color: generateMsg.ok ? '#16a34a' : '#ef4444',
            }}
          >
            <Sparkles size={13} />
            <span className="min-w-0 flex-1">{generateMsg.text}</span>
            {generateMsg.url && (
              <a
                href={generateMsg.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 underline"
                style={{ color: 'var(--accent, #6366f1)' }}
              >
                打开
                <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}

        {/* Body (scroll area) */}
        <div
          className="flex-1 px-5 py-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {isForm ? renderForm() : renderList()}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
