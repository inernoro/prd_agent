import { useCallback, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Plus, Pencil, Trash2, Sparkles, RefreshCw } from 'lucide-react';
import {
  listTipsAdmin,
  createTip,
  updateTip,
  deleteTip,
  type DailyTipAdmin,
  type DailyTipKind,
  type DailyTipUpsert,
} from '@/services/real/dailyTips';

const KIND_OPTIONS: Array<{ value: DailyTipKind; label: string; desc: string }> = [
  { value: 'text', label: '文字', desc: '副标题位一句话轮播' },
  { value: 'card', label: '卡片', desc: '右上角图文卡片' },
  { value: 'spotlight', label: '高亮', desc: '卡片 + 跳转后高亮目标元素' },
];

function emptyDraft(): DailyTipUpsert {
  return {
    kind: 'text',
    title: '',
    body: '',
    coverImageUrl: '',
    actionUrl: '/',
    ctaText: '去看看',
    targetSelector: '',
    targetUserId: '',
    displayOrder: 0,
    isActive: true,
  };
}

/** 小技巧管理 — 系统设置页 Tab。 */
export function DailyTipsEditor() {
  const [items, setItems] = useState<DailyTipAdmin[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DailyTipUpsert>(emptyDraft());
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTipsAdmin();
      if (res.success && res.data) {
        setItems(res.data.items ?? []);
      } else {
        setError(res.error?.message ?? '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setShowForm(true);
  };

  const startEdit = (tip: DailyTipAdmin) => {
    setEditingId(tip.id);
    setDraft({
      kind: tip.kind,
      title: tip.title,
      body: tip.body ?? '',
      coverImageUrl: tip.coverImageUrl ?? '',
      actionUrl: tip.actionUrl,
      ctaText: tip.ctaText ?? '去看看',
      targetSelector: tip.targetSelector ?? '',
      targetUserId: tip.targetUserId ?? '',
      targetRoles: tip.targetRoles ?? [],
      displayOrder: tip.displayOrder ?? 0,
      isActive: tip.isActive ?? true,
      startAt: tip.startAt ?? null,
      endAt: tip.endAt ?? null,
    });
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const handleSave = async () => {
    if (!draft.title.trim()) {
      setError('标题不能为空');
      return;
    }
    if (!draft.actionUrl.trim()) {
      setError('跳转链接不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: DailyTipUpsert = {
        ...draft,
        title: draft.title.trim(),
        actionUrl: draft.actionUrl.trim(),
        body: draft.body?.trim() ? draft.body.trim() : null,
        coverImageUrl: draft.coverImageUrl?.trim() ? draft.coverImageUrl.trim() : null,
        ctaText: draft.ctaText?.trim() ? draft.ctaText.trim() : '去看看',
        targetSelector: draft.targetSelector?.trim() ? draft.targetSelector.trim() : null,
        targetUserId: draft.targetUserId?.trim() ? draft.targetUserId.trim() : null,
      };
      const res = editingId
        ? await updateTip(editingId, payload)
        : await createTip(payload);
      if (res.success) {
        cancelForm();
        await load();
      } else {
        setError(res.error?.message ?? '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确认删除这条小贴士吗?')) return;
    const res = await deleteTip(id);
    if (res.success) {
      await load();
    } else {
      setError(res.error?.message ?? '删除失败');
    }
  };

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          (a.displayOrder ?? 0) - (b.displayOrder ?? 0) ||
          (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      ),
    [items],
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div>
          <h2
            className="text-[14px] font-bold inline-flex items-center gap-1.5"
            style={{ color: 'var(--text-primary)' }}
          >
            <Sparkles size={14} style={{ color: '#c4b5fd' }} />
            小技巧管理
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            首页副标题轮播、右上角引导卡片、JetBrains 式高亮引导的统一维护入口
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
            刷新
          </Button>
          <Button variant="primary" size="sm" onClick={startCreate}>
            <Plus size={14} />
            新建
          </Button>
        </div>
      </div>

      {error && (
        <div
          className="px-3 py-2 text-[12px] rounded-lg shrink-0"
          style={{
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5',
          }}
        >
          {error}
        </div>
      )}

      {showForm && (
        <GlassCard animated glow accentHue={260} className="shrink-0">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {editingId ? '编辑小贴士' : '新建小贴士'}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={cancelForm} disabled={saving}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? <MapSpinner size={14} /> : null}
                  保存
                </Button>
              </div>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="类型">
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as DailyTipKind }))}
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} - {o.desc}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="显示顺序(越小越靠前)">
                <input
                  type="number"
                  value={draft.displayOrder ?? 0}
                  onChange={(e) => setDraft((d) => ({ ...d, displayOrder: Number(e.target.value) || 0 }))}
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                />
              </Field>

              <Field label="启用" full={false}>
                <label className="inline-flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                  <input
                    type="checkbox"
                    checked={draft.isActive ?? true}
                    onChange={(e) => setDraft((d) => ({ ...d, isActive: e.target.checked }))}
                  />
                  {draft.isActive ? '启用中' : '已关闭'}
                </label>
              </Field>
            </div>

            <Field label="标题">
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="一句话抓眼球,例:海鲜市场上线了提示词一键 Fork"
                className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                style={inputStyle}
              />
            </Field>

            {(draft.kind === 'card' || draft.kind === 'spotlight') && (
              <Field label="正文(支持换行,可选)">
                <textarea
                  value={draft.body ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  rows={3}
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none resize-y"
                  style={inputStyle}
                />
              </Field>
            )}

            {(draft.kind === 'card' || draft.kind === 'spotlight') && (
              <Field label="封面图 URL(可选)">
                <input
                  type="text"
                  value={draft.coverImageUrl ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, coverImageUrl: e.target.value }))}
                  placeholder="https://..."
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                />
              </Field>
            )}

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="跳转链接(ActionUrl)">
                <input
                  type="text"
                  value={draft.actionUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, actionUrl: e.target.value }))}
                  placeholder="/marketplace"
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                />
              </Field>
              <Field label="按钮文案">
                <input
                  type="text"
                  value={draft.ctaText ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, ctaText: e.target.value }))}
                  placeholder="去看看"
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                />
              </Field>
            </div>

            {(draft.kind === 'text' || draft.kind === 'spotlight') && (
              <Field
                label='落地页 DOM 选择器(TargetSelector,可选)'
                hint='例:[data-tour-id=quicklink-marketplace]  跳转后该元素会被脉冲光圈高亮'
              >
                <input
                  type="text"
                  value={draft.targetSelector ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, targetSelector: e.target.value }))}
                  placeholder="[data-tour-id=quicklink-marketplace]"
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                />
              </Field>
            )}

            <Field
              label="定向推送给用户 ID(可选)"
              hint="非空时仅该用户可见,在首页自动置顶,适合「为你修复」类个性化推送"
            >
              <input
                type="text"
                value={draft.targetUserId ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, targetUserId: e.target.value }))}
                placeholder="留空则所有登录用户可见"
                className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                style={inputStyle}
              />
            </Field>
          </div>
        </GlassCard>
      )}

      <div className="flex flex-col gap-2">
        {sorted.length === 0 && !loading && (
          <div
            className="p-8 text-center text-[13px] rounded-xl"
            style={{
              border: '1px dashed var(--border-subtle)',
              color: 'var(--text-muted)',
            }}
          >
            还没有小贴士 — 创建第一条,新用户登录首页就能看到。
            <br />
            清空后首页会自动回退到一组内置默认 tip。
          </div>
        )}
        {sorted.map((tip) => (
          <div
            key={tip.id}
            className="flex items-start gap-3 p-3 rounded-xl"
            style={{
              background: 'var(--nested-block-bg)',
              border: '1px solid var(--nested-block-border)',
            }}
          >
            <div
              className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{
                background: tip.isActive ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
                color: tip.isActive ? '#86efac' : '#94a3b8',
                marginTop: 2,
              }}
            >
              {tip.isActive ? '启用' : '关闭'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{
                    background: 'rgba(129,140,248,0.12)',
                    color: '#c4b5fd',
                  }}
                >
                  {tip.kind}
                </span>
                {tip.targetUserId && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'linear-gradient(135deg, rgba(244,63,94,0.15), rgba(168,85,247,0.12))',
                      color: '#fca5a5',
                    }}
                  >
                    定向 {tip.targetUserId.slice(0, 8)}…
                  </span>
                )}
                <span
                  className="text-[10px] font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  order={tip.displayOrder}
                </span>
                {tip.sourceType && tip.sourceType !== 'manual' && (
                  <span
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                    style={{
                      background: 'rgba(245,158,11,0.12)',
                      color: '#fbbf24',
                    }}
                  >
                    {tip.sourceType}
                  </span>
                )}
              </div>
              <div
                className="mt-1 text-[13px] font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                {tip.title}
              </div>
              {tip.body && (
                <div
                  className="mt-0.5 text-[12px] line-clamp-2"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {tip.body}
                </div>
              )}
              <div className="mt-1 text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                → {tip.actionUrl}
                {tip.targetSelector ? ` (${tip.targetSelector})` : ''}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="sm" onClick={() => startEdit(tip)}>
                <Pencil size={12} />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleDelete(tip.id)}>
                <Trash2 size={12} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

function Field({
  label,
  hint,
  children,
  full = true,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? 'w-full' : ''}>
      <div
        className="text-[11px] font-medium mb-1"
        style={{ color: 'var(--text-secondary)' }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
