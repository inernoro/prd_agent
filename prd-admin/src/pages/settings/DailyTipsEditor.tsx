import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Plus, Pencil, Trash2, Sparkles, RefreshCw, Send, X, Users, Wand2, Play, RotateCcw, Rocket, Wrench, Lightbulb, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { writeSpotlightPayload } from '@/components/daily-tips/TipsRotator';
import { useAuthStore } from '@/stores/authStore';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import {
  listTipsAdmin,
  createTip,
  updateTip,
  deleteTip,
  pushTip,
  getTipStats,
  seedDefaultTips,
  resetDefaultTips,
  type DailyTipAdmin,
  type DailyTipKind,
  type DailyTipUpsert,
  type DailyTipDelivery,
  type DailyTipStatsSummary,
  type DailyTipAutoAction,
} from '@/services/real/dailyTips';

const KIND_OPTIONS: Array<{ value: DailyTipKind; label: string; desc: string }> = [
  { value: 'text', label: '文字', desc: '副标题位一句话轮播' },
  { value: 'card', label: '卡片', desc: '右上角图文卡片' },
  { value: 'spotlight', label: '高亮', desc: '卡片 + 跳转后高亮目标元素' },
];

/** sourceType 注册表 —— 禁止 switch,按 `frontend-architecture.md` 规则用 registry */
type SourceKind = 'feature-release' | 'tip' | 'bug-fix' | 'onboarding' | 'manual' | 'seed';
const SOURCE_REGISTRY: Record<SourceKind, { label: string; color: string; bg: string; border: string; icon: typeof Rocket }> = {
  'feature-release': { label: '新功能', color: '#a78bfa', bg: 'rgba(167,139,250,0.14)', border: 'rgba(167,139,250,0.35)', icon: Rocket },
  'tip':             { label: '技巧',   color: '#86efac', bg: 'rgba(134,239,172,0.14)', border: 'rgba(134,239,172,0.35)', icon: Lightbulb },
  'bug-fix':         { label: '缺陷修复', color: '#fbbf24', bg: 'rgba(251,191,36,0.14)', border: 'rgba(251,191,36,0.35)', icon: Wrench },
  'onboarding':      { label: '新手教程', color: '#67e8f9', bg: 'rgba(103,232,249,0.14)', border: 'rgba(103,232,249,0.35)', icon: Sparkles },
  'manual':          { label: '手建',   color: '#cbd5e1', bg: 'rgba(203,213,225,0.10)', border: 'rgba(203,213,225,0.25)', icon: Pencil },
  'seed':            { label: '内置',   color: '#fdba74', bg: 'rgba(253,186,116,0.14)', border: 'rgba(253,186,116,0.35)', icon: Sparkles },
};
const SOURCE_OPTIONS: SourceKind[] = ['feature-release', 'tip', 'bug-fix', 'onboarding', 'manual'];
function sourceMeta(s: string | null | undefined) {
  return SOURCE_REGISTRY[(s as SourceKind) ?? 'manual'] ?? SOURCE_REGISTRY.manual;
}

function emptyDraft(): DailyTipUpsert & { sourceType?: string } {
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
    autoAction: null,
    sourceType: 'manual',
  };
}

/** 把 UI 草稿上的 autoAction 规整一次:空字符串视为 null,全空字段整体返回 null。 */
function normalizeAutoAction(a: DailyTipAutoAction | null | undefined): DailyTipAutoAction | null {
  if (!a) return null;
  const scroll = a.scroll && a.scroll !== 'center' ? a.scroll : a.scroll === 'center' ? 'center' : null;
  const expand = a.expand?.trim() ? a.expand.trim() : null;
  const prefill =
    a.prefill?.selector?.trim() && a.prefill?.value !== undefined
      ? { selector: a.prefill.selector.trim(), value: a.prefill.value ?? '' }
      : null;
  const autoClick = a.autoClick?.trim() ? a.autoClick.trim() : null;
  const autoClickDelayMs = autoClick ? (a.autoClickDelayMs ?? 1200) : null;
  const steps = (a.steps ?? [])
    .map((s) => ({
      selector: s.selector?.trim() ?? '',
      title: s.title?.trim() ?? '',
      body: s.body?.trim() ? s.body.trim() : null,
    }))
    .filter((s) => s.selector && s.title);

  if (!scroll && !expand && !prefill && !autoClick && steps.length === 0) {
    return null;
  }
  return {
    scroll,
    expand,
    prefill,
    autoClick,
    autoClickDelayMs,
    steps: steps.length > 0 ? steps : null,
  };
}

/** 小技巧管理 — 系统设置页 Tab。 */
export function DailyTipsEditor() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DailyTipAdmin[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DailyTipUpsert>(emptyDraft());
  const [showForm, setShowForm] = useState(false);
  const [pushingTip, setPushingTip] = useState<DailyTipAdmin | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  // 多选 + 批量推送
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTargetUser, setBulkTargetUser] = useState<string>('');
  const [bulkPushing, setBulkPushing] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

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
      autoAction: tip.autoAction ?? null,
      sourceType: tip.sourceType ?? 'manual',
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
        autoAction: normalizeAutoAction(draft.autoAction),
        sourceType: draft.sourceType ?? 'manual',
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

  // 不走推送,直接在当前账号试播一次完整引导(跳转 + SpotlightOverlay autoAction)。
  // 管理员在保存后不需要推给自己或真人用户,点这个按钮就能立刻看效果。
  const handleTest = (tip: DailyTipAdmin) => {
    writeSpotlightPayload({
      id: tip.id,
      kind: tip.kind,
      title: tip.title,
      body: tip.body ?? null,
      actionUrl: tip.actionUrl,
      ctaText: tip.ctaText ?? null,
      targetSelector: tip.targetSelector ?? null,
      autoAction: tip.autoAction ?? null,
    });
    navigate(tip.actionUrl || '/');
  };

  const handleSeed = async () => {
    setSeeding(true);
    setSeedMsg(null);
    setError(null);
    try {
      const res = await seedDefaultTips();
      if (res.success && res.data) {
        const { insertedCount, skippedCount, totalDefaults } = res.data;
        setSeedMsg(
          insertedCount > 0
            ? `已植入 ${insertedCount} 条内置小贴士${skippedCount > 0 ? `(跳过 ${skippedCount} 条已存在)` : ''}`
            : `全部 ${totalDefaults} 条内置小贴士均已存在,未新增`,
        );
        await load();
      } else {
        setError(res.error?.message ?? '植入失败');
      }
    } finally {
      setSeeding(false);
    }
  };

  /** 清空所有 DailyTip 然后用最新 seed 重新植入。跟 handleSeed 的区别:
   *  handleSeed 按 SourceId 跳过已存在的,resetAll 会删全部再重建。 */
  // 多选 / 全选 / 批量推送
  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };
  const toggleSelectAll = () => {
    if (selectedIds.size === sorted.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(sorted.map((t) => t.id)));
  };
  const handleBulkPush = async (scope?: string) => {
    const tipIds = Array.from(selectedIds);
    if (tipIds.length === 0) return;
    if (!scope && !bulkTargetUser) {
      setBulkMsg('选择一个目标用户或按角色批量');
      return;
    }
    if (!window.confirm(`确认把选中的 ${tipIds.length} 条推给 ${scope ?? bulkTargetUser}?`)) return;
    setBulkPushing(true);
    setBulkMsg(null);
    try {
      let ok = 0;
      for (const tipId of tipIds) {
        const res = scope
          ? await pushTip(tipId, { scope, maxViews: 3, reset: true })
          : await pushTip(tipId, { userIds: [bulkTargetUser], maxViews: 3, reset: true });
        if (res.success) ok++;
      }
      setBulkMsg(`已推送 ${ok}/${tipIds.length} 条成功(用户下次轮询立刻收到)`);
      setSelectedIds(new Set());
      setBulkTargetUser('');
      await load();
    } finally {
      setBulkPushing(false);
    }
  };

  const handleResetAll = async () => {
    if (!window.confirm('将删除所有现有小贴士(含管理员自建的)并重新植入内置 seed。确认吗?')) {
      return;
    }
    setSeeding(true);
    setSeedMsg(null);
    setError(null);
    try {
      const res = await resetDefaultTips();
      if (res.success && res.data) {
        const { deletedCount, insertedCount } = res.data;
        setSeedMsg(`已删除 ${deletedCount} 条,重新植入 ${insertedCount} 条`);
        await load();
      } else {
        setError(res.error?.message ?? '重置失败');
      }
    } finally {
      setSeeding(false);
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
    <div
      className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto mx-auto w-full"
      style={{ maxWidth: 1180, padding: '0 4px' }}
    >
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleSeed()}
            disabled={seeding}
            title="按 SourceId 幂等植入默认小贴士;已存在的会跳过"
          >
            {seeding ? <MapSpinner size={14} /> : <Wand2 size={14} />}
            一键植入默认
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleResetAll()}
            disabled={seeding}
            title="清空所有小贴士(含自建的)并重新植入最新 seed —— 危险,会二次确认"
          >
            {seeding ? <MapSpinner size={14} /> : <RotateCcw size={14} />}
            清空并重建
          </Button>
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

      {seedMsg && (
        <div
          className="px-3 py-2 text-[12px] rounded-lg shrink-0 flex items-center justify-between gap-2"
          style={{
            background: 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.35)',
            color: '#86efac',
          }}
        >
          <span>{seedMsg}</span>
          <button
            type="button"
            onClick={() => setSeedMsg(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      )}

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

              <Field label="场景分类">
                <select
                  value={draft.sourceType ?? 'manual'}
                  onChange={(e) => setDraft((d) => ({ ...d, sourceType: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                >
                  {SOURCE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_REGISTRY[s].label}
                    </option>
                  ))}
                </select>
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

            <AutoActionEditor
              value={draft.autoAction ?? null}
              onChange={(next) => setDraft((d) => ({ ...d, autoAction: next }))}
              fallbackSelector={draft.targetSelector ?? undefined}
            />
          </div>
        </GlassCard>
      )}

      {/* 批量操作条 —— 选中一条及以上时浮现,苹果风 */}
      {selectedIds.size > 0 && (
        <div
          className="flex items-center gap-3 rounded-2xl shrink-0"
          style={{
            padding: '12px 14px',
            background: 'linear-gradient(135deg, rgba(129,140,248,0.12), rgba(167,139,250,0.08))',
            border: '1px solid rgba(129,140,248,0.35)',
            boxShadow: '0 8px 24px -10px rgba(129,140,248,0.35)',
          }}
        >
          <div className="inline-flex items-center gap-2 shrink-0">
            <span
              className="inline-flex items-center justify-center rounded-full"
              style={{
                width: 24, height: 24,
                background: 'linear-gradient(135deg, rgba(129,140,248,0.95), rgba(167,139,250,0.95))',
                color: '#fff',
                fontSize: 12, fontWeight: 700,
              }}
            >
              {selectedIds.size}
            </span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              已选 {selectedIds.size} 条
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <UserSearchSelect
              value={bulkTargetUser}
              onChange={setBulkTargetUser}
              placeholder="搜索目标用户(立即推送,用户下次轮询就收到)"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleBulkPush()}
            disabled={bulkPushing || !bulkTargetUser}
          >
            {bulkPushing ? <MapSpinner size={14} /> : <Send size={14} />}
            推送给选中用户
          </Button>
          <div className="flex items-center gap-1 shrink-0">
            {(['all', 'role:PM', 'role:DEV', 'role:QA'] as const).map((scope) => (
              <Button
                key={scope}
                variant="secondary"
                size="sm"
                onClick={() => void handleBulkPush(scope)}
                disabled={bulkPushing}
                title={scope === 'all' ? '推给全部活跃用户' : `推给所有 ${scope.replace('role:', '')}`}
              >
                <Users size={11} />
                {scope === 'all' ? '全体' : scope.replace('role:', '')}
              </Button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())} title="取消选择">
            <X size={12} />
          </Button>
        </div>
      )}
      {bulkMsg && (
        <div
          className="px-3 py-2 text-[12px] rounded-lg shrink-0"
          style={{
            background: 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.35)',
            color: '#86efac',
          }}
        >
          {bulkMsg}
        </div>
      )}

      {/* 列表头 —— 全选 chip */}
      {sorted.length > 0 && (
        <div
          className="flex items-center gap-2 px-1 shrink-0"
          style={{ color: 'var(--text-muted)' }}
        >
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1.5 text-[12px] transition-colors hover:text-[color:var(--text-secondary)]"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <div
              className="inline-flex items-center justify-center rounded-full"
              style={{
                width: 18,
                height: 18,
                border: selectedIds.size === sorted.length
                  ? '1px solid rgba(129,140,248,0.8)'
                  : '1.5px solid rgba(255,255,255,0.2)',
                background: selectedIds.size === sorted.length
                  ? 'rgba(129,140,248,0.85)'
                  : 'transparent',
              }}
            >
              {selectedIds.size === sorted.length && <Check size={11} strokeWidth={3} color="#fff" />}
            </div>
            {selectedIds.size === sorted.length ? '取消全选' : `全选(共 ${sorted.length} 条)`}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {sorted.length === 0 && !loading && (
          <div
            className="p-8 rounded-xl flex flex-col items-center gap-4 text-center"
            style={{
              border: '1px dashed var(--border-subtle)',
              color: 'var(--text-muted)',
              background:
                'linear-gradient(180deg, rgba(168,85,247,0.04), rgba(129,140,248,0.02))',
            }}
          >
            <Sparkles size={32} style={{ color: '#c4b5fd', opacity: 0.75 }} />
            <div className="flex flex-col gap-1.5">
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                还没有小贴士
              </div>
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                可以「一键植入默认」把 8 条内置 seed 灌进数据库,之后随便改 / 加 / 删;
                <br />
                也可以直接「新建」从零写一条自己的。
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleSeed()}
                disabled={seeding}
              >
                {seeding ? <MapSpinner size={14} /> : <Wand2 size={14} />}
                一键植入默认
              </Button>
              <Button variant="secondary" size="sm" onClick={startCreate}>
                <Plus size={14} /> 从零新建
              </Button>
            </div>
          </div>
        )}
        {sorted.map((tip) => {
          const selected = selectedIds.has(tip.id);
          const source = sourceMeta(tip.sourceType);
          const SourceIcon = source.icon;
          const stepCount = tip.autoAction?.steps?.length ?? 0;
          return (
            <div
              key={tip.id}
              onClick={() => toggleSelect(tip.id)}
              className="group relative flex items-center gap-3 cursor-pointer transition-colors"
              style={{
                background: selected ? 'rgba(129,140,248,0.08)' : 'transparent',
                border: selected
                  ? '1px solid rgba(129,140,248,0.4)'
                  : '1px solid rgba(255,255,255,0.05)',
                borderRadius: 14,
                padding: '12px 14px',
                transition: 'background 180ms ease-out, border-color 180ms ease-out',
              }}
              onMouseEnter={(e) => {
                if (!selected) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                }
              }}
              onMouseLeave={(e) => {
                if (!selected) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)';
                }
              }}
            >
              {/* 1. checkbox */}
              <div
                className="shrink-0 flex items-center justify-center rounded-full"
                style={{
                  width: 20,
                  height: 20,
                  border: selected
                    ? 'none'
                    : '1.5px solid rgba(255,255,255,0.22)',
                  background: selected
                    ? 'linear-gradient(135deg, #818cf8, #a78bfa)'
                    : 'transparent',
                  transition: 'all 150ms ease-out',
                }}
              >
                {selected && <Check size={12} strokeWidth={3} color="#fff" />}
              </div>

              {/* 2. 源色小圆圈 —— 代替之前的 chip 文字,视觉更简洁 */}
              <div
                className="shrink-0 flex items-center justify-center rounded-xl"
                style={{
                  width: 34,
                  height: 34,
                  background: source.bg,
                  border: `1px solid ${source.border}`,
                  color: source.color,
                }}
                title={source.label}
              >
                <SourceIcon size={16} />
              </div>

              {/* 3. 主体:标题行 + meta 行,flex-1 自然填满 */}
              <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      flex: '0 1 auto',
                      maxWidth: '60%',
                    }}
                  >
                    {tip.title}
                  </span>
                  {/* 小型内嵌 meta:步数 · kind · 定向 */}
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      flexShrink: 0,
                    }}
                  >
                    {stepCount > 0 && (
                      <span style={{ color: '#c4b5fd' }}>{stepCount} Tour</span>
                    )}
                    <span style={{ opacity: 0.6 }}>·</span>
                    <span>{tip.kind}</span>
                    {!tip.isActive && (
                      <>
                        <span style={{ opacity: 0.6 }}>·</span>
                        <span style={{ color: '#94a3b8' }}>已关闭</span>
                      </>
                    )}
                    {tip.targetUserId && (
                      <>
                        <span style={{ opacity: 0.6 }}>·</span>
                        <span style={{ color: '#fca5a5' }}>为你</span>
                      </>
                    )}
                  </span>
                </div>
                {/* 第二行:body(如有)或 actionUrl */}
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginTop: 3,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.4,
                  }}
                >
                  {tip.body ? (
                    <>
                      <span style={{ color: 'var(--text-secondary)' }}>{tip.body}</span>
                      <span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>
                    </>
                  ) : null}
                  <span
                    style={{
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      fontSize: 11,
                      opacity: 0.75,
                    }}
                  >
                    → {tip.actionUrl}
                  </span>
                </div>
              </div>

              {/* 4. 右列:#N + 操作按钮,紧贴不留空 */}
              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <span
                  style={{
                    fontFamily: 'ui-monospace, Menlo, monospace',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.35)',
                    marginRight: 4,
                    minWidth: 24,
                    textAlign: 'right',
                  }}
                >
                  #{tip.displayOrder}
                </span>
                <Button variant="ghost" size="sm" onClick={() => handleTest(tip)} title="试播">
                  <Play size={12} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPushingTip(tip)} title="推送">
                  <Send size={12} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => startEdit(tip)} title="编辑">
                  <Pencil size={12} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleDelete(tip.id)} title="删除">
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {pushingTip && (
        <PushDialog
          tip={pushingTip}
          onClose={() => setPushingTip(null)}
          onPushed={() => void load()}
        />
      )}
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

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: '待查看', color: '#fcd34d', bg: 'rgba(251,191,36,0.12)' },
  seen: { label: '已看到', color: '#86efac', bg: 'rgba(34,197,94,0.12)' },
  clicked: { label: '已点击', color: '#93c5fd', bg: 'rgba(59,130,246,0.12)' },
  dismissed: { label: '已关闭', color: '#cbd5e1', bg: 'rgba(148,163,184,0.12)' },
};

/**
 * 推送对话框 — 选择用户、设置最大展示次数、查看已推送列表 + 统计。
 * 遵循 frontend-modal 3 硬约束:inline style 高度 / createPortal / min-h:0 滚动。
 */
function PushDialog({
  tip,
  onClose,
  onPushed,
}: {
  tip: DailyTipAdmin;
  onClose: () => void;
  onPushed: () => void;
}) {
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [maxViews, setMaxViews] = useState<number>(3);
  const [reset, setReset] = useState<boolean>(false);
  const [pushing, setPushing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<DailyTipStatsSummary | null>(null);
  const [deliveries, setDeliveries] = useState<DailyTipDelivery[]>([]);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTipStats(tip.id);
      if (res.success && res.data) {
        setSummary(res.data.summary);
        setDeliveries(res.data.items ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [tip.id]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // ESC close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handlePush = async () => {
    if (!selectedUser) {
      setPushErr('请选择要推送的用户');
      return;
    }
    setPushErr(null);
    setPushing(true);
    try {
      const res = await pushTip(tip.id, {
        userIds: [selectedUser],
        maxViews,
        reset,
      });
      if (res.success) {
        setSelectedUser('');
        await loadStats();
        onPushed();
      } else {
        setPushErr(res.error?.message ?? '推送失败');
      }
    } finally {
      setPushing(false);
    }
  };

  // 「推给我自己」:管理员一键推给当前账号,方便端到端自测
  const myUserId = useAuthStore((s) => s.user?.userId);
  const handlePushToMe = async () => {
    if (!myUserId) {
      setPushErr('未登录,无法推给自己');
      return;
    }
    setPushErr(null);
    setPushing(true);
    try {
      const res = await pushTip(tip.id, {
        userIds: [myUserId],
        maxViews,
        reset: true, // 每次推给自己都重置,方便反复测
      });
      if (res.success) {
        await loadStats();
        onPushed();
      } else {
        setPushErr(res.error?.message ?? '推送失败');
      }
    } finally {
      setPushing(false);
    }
  };

  // 按 scope 批量推送(all / role:DEV 等)
  const handlePushByScope = async (scope: string, label: string) => {
    if (!window.confirm(`确认推送给 ${label}?此操作可能涉及很多用户。`)) return;
    setPushErr(null);
    setPushing(true);
    try {
      const res = await pushTip(tip.id, { scope, maxViews, reset });
      if (res.success && res.data) {
        await loadStats();
        onPushed();
      } else {
        setPushErr(res.error?.message ?? '批量推送失败');
      }
    } finally {
      setPushing(false);
    }
  };

  const modal = (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col"
        style={{
          width: 'min(960px, 100%)',
          height: 'min(720px, 100%)',
          maxHeight: '88vh',
          background: 'linear-gradient(180deg, rgba(22,22,28,0.98), rgba(15,16,20,0.98))',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 16,
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.8)',
        }}
      >
        <div
          className="shrink-0"
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="flex items-center gap-2">
            <Send size={14} style={{ color: '#c4b5fd' }} />
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              推送小贴士
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
            }}
            title="关闭 (ESC)"
          >
            <X size={14} />
          </button>
        </div>

        <div
          className="flex-1 flex"
          style={{
            minHeight: 0,
          }}
        >
          {/* ── 左栏:tip 信息 + 推送表单 ── */}
          <div
            className="flex flex-col"
            style={{
              flex: '0 0 46%',
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              padding: '14px 18px',
              borderRight: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div
              className="p-3 rounded-xl mb-4"
              style={{
                background: 'rgba(129,140,248,0.08)',
                border: '1px solid rgba(129,140,248,0.18)',
              }}
            >
              <div className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                tip #{tip.id.slice(0, 8)} · {tip.kind}
              </div>
              <div className="text-[13px] font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
                {tip.title}
              </div>
              {tip.body && (
                <div className="text-[12px] mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                  {tip.body}
                </div>
              )}
              <div className="text-[11px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>
                → {tip.actionUrl}
              </div>
            </div>

            <Field label="推送给用户">
              <UserSearchSelect
                value={selectedUser}
                onChange={setSelectedUser}
                placeholder="搜索用户名或昵称..."
              />
            </Field>

            <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Field label="最大展示次数(-1 无限)" hint="达到后该用户不再看到">
                <input
                  type="number"
                  value={maxViews}
                  onChange={(e) => setMaxViews(Number(e.target.value) || 1)}
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                  min={-1}
                />
              </Field>
              <Field label="重置已有记录" hint="勾选后若已推送过则把状态重置为 pending">
                <label className="inline-flex items-center gap-2 text-[13px] mt-1.5" style={{ color: 'var(--text-primary)' }}>
                  <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} />
                  再推一次(重置)
                </label>
              </Field>
            </div>

            {pushErr && (
              <div
                className="mt-3 px-3 py-2 text-[12px] rounded-lg"
                style={{
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.35)',
                  color: '#fca5a5',
                }}
              >
                {pushErr}
              </div>
            )}

            <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handlePushToMe()}
                disabled={pushing || !myUserId}
                title="一键推给当前账号,方便端到端自测(每次推送会重置 delivery 状态)"
              >
                {pushing ? <MapSpinner size={14} /> : <Send size={14} />}
                推给我自己
              </Button>
              <Button variant="primary" size="sm" onClick={() => void handlePush()} disabled={pushing || !selectedUser}>
                {pushing ? <MapSpinner size={14} /> : <Send size={14} />}
                推送
              </Button>
            </div>

            {/* 按角色批量推送 —— 会在后端按 UserRole 展开所有活跃用户 */}
            <div
              className="mt-4 pt-3"
              style={{ borderTop: '1px dashed rgba(255,255,255,0.08)' }}
            >
              <Field
                label="批量推送(按范围)"
                hint="一键推给某个角色或全体,会在后端按 UserStatus=Active 过滤"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {(['all', 'role:PM', 'role:DEV', 'role:QA', 'role:ADMIN'] as const).map((scope) => (
                    <Button
                      key={scope}
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void handlePushByScope(
                          scope,
                          scope === 'all' ? '全体活跃用户' : scope.replace('role:', ''),
                        )
                      }
                      disabled={pushing}
                    >
                      <Users size={12} />
                      {scope === 'all' ? '全体' : scope.replace('role:', '')}
                    </Button>
                  ))}
                </div>
              </Field>
            </div>
          </div>

          {/* ── 右栏:已推送统计 + 用户列表 ── */}
          <div
            className="flex-1 flex flex-col"
            style={{
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <div
              className="shrink-0 flex items-center justify-between"
              style={{
                padding: '14px 18px 8px',
              }}
            >
              <div className="flex items-center gap-2">
                <Users size={13} style={{ color: 'var(--text-muted)' }} />
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  已推送用户状态
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void loadStats()} disabled={loading}>
                {loading ? <MapSpinner size={12} /> : <RefreshCw size={12} />}
                刷新
              </Button>
            </div>

            {summary && (
              <div
                className="shrink-0 flex items-center gap-2 flex-wrap"
                style={{ padding: '0 18px 8px' }}
              >
                <StatChip label="总计" value={summary.total} color="#cbd5e1" bg="rgba(148,163,184,0.12)" />
                <StatChip label="待查看" value={summary.pending} color="#fcd34d" bg="rgba(251,191,36,0.12)" />
                <StatChip label="已看到" value={summary.seen} color="#86efac" bg="rgba(34,197,94,0.12)" />
                <StatChip label="已点击" value={summary.clicked} color="#93c5fd" bg="rgba(59,130,246,0.12)" />
                <StatChip label="已关闭" value={summary.dismissed} color="#cbd5e1" bg="rgba(148,163,184,0.12)" />
              </div>
            )}

            <div
              className="flex-1"
              style={{
                minHeight: 0,
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                padding: '4px 18px 14px',
              }}
            >
              {deliveries.length === 0 ? (
                <div
                  className="p-5 text-center text-[12px] rounded-xl"
                  style={{
                    border: '1px dashed var(--border-subtle)',
                    color: 'var(--text-muted)',
                  }}
                >
                  尚未推送给任何用户。选择用户后点击「推送」即可。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {deliveries.map((d) => {
                    const meta = STATUS_META[d.status] ?? STATUS_META.pending;
                    return (
                      <div
                        key={d.userId}
                        className="flex items-center gap-3 p-2.5 rounded-lg"
                        style={{
                          background: 'var(--nested-block-bg)',
                          border: '1px solid var(--nested-block-border)',
                        }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {d.userDisplayName ?? d.userId.slice(0, 8) + '…'}
                            </span>
                            <span
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                              style={{ background: meta.bg, color: meta.color }}
                            >
                              {meta.label}
                            </span>
                          </div>
                          <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            展示 {d.viewCount}/{d.maxViews === -1 ? '∞' : d.maxViews}
                            {d.lastSeenAt ? ` · 上次 ${new Date(d.lastSeenAt).toLocaleString()}` : ''}
                            {d.clickedAt ? ` · 已点击 ${new Date(d.clickedAt).toLocaleString()}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/**
 * 自动引导编辑器 — 模板模式简化版。
 *
 * 用户先选「引导模板」(none / highlight / autoclick / prefill / tour),
 * 然后只填该模板需要的字段;不再面对一片散开的 5+ 字段。
 * 「显示高级配置」开关为硬核场景兜底,展开完整字段(scroll / expand 等)。
 */
type GuideTemplate = 'none' | 'highlight' | 'autoclick' | 'prefill' | 'tour';

function detectTemplate(a: DailyTipAutoAction | null): GuideTemplate {
  if (!a) return 'none';
  if (a.steps && a.steps.length > 0) return 'tour';
  if (a.prefill?.selector) return 'prefill';
  if (a.autoClick) return 'autoclick';
  // scroll-only / 啥都没有 → highlight(默认行为)
  return 'highlight';
}

const TEMPLATE_META: Record<GuideTemplate, { label: string; desc: string }> = {
  none: { label: '不引导', desc: '只跳转,不画高亮' },
  highlight: { label: '跳转后高亮元素', desc: '在落地页画一个脉冲圈,最常用' },
  autoclick: { label: '高亮 + 自动点击', desc: '延迟若干毫秒后自动点击目标按钮' },
  prefill: { label: '高亮 + 预填输入', desc: '把输入框 / 搜索框预填好' },
  tour: { label: '多步 Tour', desc: '逐步引导,用户点「下一步」前进' },
};

function AutoActionEditor({
  value,
  onChange,
  fallbackSelector,
}: {
  value: DailyTipAutoAction | null;
  onChange: (next: DailyTipAutoAction | null) => void;
  /** 父级的 targetSelector,用作 selector 字段的占位提示 */
  fallbackSelector?: string;
}) {
  const [template, setTemplate] = useState<GuideTemplate>(() => detectTemplate(value));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // value 从外面被替换(如切换编辑对象时),把模板状态同步刷一下
  useEffect(() => {
    setTemplate(detectTemplate(value));
  }, [value]);

  const a: DailyTipAutoAction = value ?? {};

  const switchTemplate = (next: GuideTemplate) => {
    setTemplate(next);
    if (next === 'none') {
      onChange(null);
      return;
    }
    if (next === 'highlight') {
      onChange({ scroll: 'center' });
      return;
    }
    if (next === 'autoclick') {
      onChange({
        scroll: 'center',
        autoClick: a.autoClick ?? '',
        autoClickDelayMs: a.autoClickDelayMs ?? 1200,
      });
      return;
    }
    if (next === 'prefill') {
      onChange({
        scroll: 'center',
        prefill: a.prefill ?? { selector: '', value: '' },
      });
      return;
    }
    // tour
    onChange({
      scroll: 'center',
      steps: a.steps && a.steps.length > 0
        ? a.steps
        : [{ selector: '', title: '', body: null }],
    });
  };

  const patch = (partial: Partial<DailyTipAutoAction>) => {
    onChange({ ...a, ...partial });
  };

  const steps = a.steps ?? [];

  const updateStep = (
    i: number,
    patchStep: Partial<{ selector: string; title: string; body: string | null }>,
  ) => {
    const next = steps.slice();
    next[i] = { ...next[i], ...patchStep };
    patch({ steps: next });
  };

  const addStep = () => {
    patch({ steps: [...steps, { selector: '', title: '', body: null }] });
  };

  const removeStep = (i: number) => {
    patch({ steps: steps.filter((_, idx) => idx !== i) });
  };

  return (
    <div
      className="rounded-xl p-3 flex flex-col gap-3"
      style={{
        background: 'rgba(168,85,247,0.05)',
        border: '1px dashed rgba(168,85,247,0.25)',
      }}
    >
      <div>
        <div
          className="text-[12px] font-semibold inline-flex items-center gap-1.5"
          style={{ color: 'var(--text-primary)' }}
        >
          <Sparkles size={12} style={{ color: '#c4b5fd' }} />
          落地页引导
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          先选模板,再只填该模板需要的字段。复杂场景可打开「高级配置」
        </div>
      </div>

      {/* ── 模板选择(分段控件) ── */}
      <div
        className="flex items-center gap-1 p-1 rounded-lg flex-wrap"
        style={{ background: 'rgba(255,255,255,0.03)' }}
      >
        {(Object.keys(TEMPLATE_META) as GuideTemplate[]).map((key) => {
          const meta = TEMPLATE_META[key];
          const active = template === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => switchTemplate(key)}
              title={meta.desc}
              className="px-2.5 py-1 rounded-md text-[12px] transition-all"
              style={{
                background: active ? 'rgba(168,85,247,0.22)' : 'transparent',
                color: active ? '#e9d5ff' : 'var(--text-muted)',
                border: active
                  ? '1px solid rgba(168,85,247,0.4)'
                  : '1px solid transparent',
                cursor: 'pointer',
                fontWeight: active ? 600 : 500,
              }}
            >
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {TEMPLATE_META[template].desc}
      </div>

      {/* ── 模板专属字段 ── */}
      {template === 'autoclick' && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
        >
          <Field label="自动点击的元素 Selector">
            <input
              type="text"
              value={a.autoClick ?? ''}
              onChange={(e) => patch({ autoClick: e.target.value || null })}
              placeholder={fallbackSelector || '[data-tour-id=xxx-submit]'}
              className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none font-mono"
              style={inputStyle}
            />
          </Field>
          <Field label="点击延迟 (毫秒)" hint="留空则用默认 1200ms">
            <input
              type="number"
              value={a.autoClickDelayMs ?? 1200}
              onChange={(e) =>
                patch({ autoClickDelayMs: Number(e.target.value) || 0 })
              }
              className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
              style={inputStyle}
              min={0}
            />
          </Field>
        </div>
      )}

      {template === 'prefill' && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
        >
          <Field label="预填的输入框 Selector">
            <input
              type="text"
              value={a.prefill?.selector ?? ''}
              onChange={(e) =>
                patch({
                  prefill: e.target.value
                    ? { selector: e.target.value, value: a.prefill?.value ?? '' }
                    : null,
                })
              }
              placeholder={fallbackSelector || '[data-tour-id=xxx-search]'}
              className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none font-mono"
              style={inputStyle}
            />
          </Field>
          <Field label="预填内容">
            <input
              type="text"
              value={a.prefill?.value ?? ''}
              onChange={(e) =>
                patch({
                  prefill: a.prefill?.selector
                    ? { selector: a.prefill.selector, value: e.target.value }
                    : null,
                })
              }
              placeholder="周报"
              className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
              style={inputStyle}
              disabled={!a.prefill?.selector}
            />
          </Field>
        </div>
      )}

      {template === 'tour' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div
              className="text-[11px]"
              style={{ color: 'var(--text-muted)' }}
            >
              逐步引导,每一步画一个脉冲圈 + 气泡卡,用户点「下一步」前进
            </div>
            <Button variant="secondary" size="sm" onClick={addStep}>
              <Plus size={12} /> 新增步骤
            </Button>
          </div>
          {steps.length === 0 ? (
            <div
              className="p-3 text-center text-[11px] rounded-lg"
              style={{
                border: '1px dashed var(--border-subtle)',
                color: 'var(--text-muted)',
              }}
            >
              还没有步骤,点「新增步骤」开始
            </div>
          ) : (
            steps.map((step, i) => (
              <div
                key={i}
                className="p-2.5 rounded-lg flex flex-col gap-2"
                style={{
                  background: 'var(--nested-block-bg)',
                  border: '1px solid var(--nested-block-border)',
                }}
              >
                <div className="flex items-center justify-between">
                  <div
                    className="text-[11px] font-mono"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Step {i + 1} / {steps.length}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeStep(i)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
                <div
                  className="grid gap-2"
                  style={{
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  }}
                >
                  <input
                    type="text"
                    value={step.selector}
                    onChange={(e) =>
                      updateStep(i, { selector: e.target.value })
                    }
                    placeholder="[data-tour-id=xxx]"
                    className="w-full px-2 py-1.5 rounded-lg text-[12px] outline-none font-mono"
                    style={inputStyle}
                  />
                  <input
                    type="text"
                    value={step.title}
                    onChange={(e) => updateStep(i, { title: e.target.value })}
                    placeholder="步骤标题,例:第 1 步:选模板"
                    className="w-full px-2 py-1.5 rounded-lg text-[12px] outline-none"
                    style={inputStyle}
                  />
                </div>
                <textarea
                  value={step.body ?? ''}
                  onChange={(e) =>
                    updateStep(i, { body: e.target.value || null })
                  }
                  placeholder="步骤说明(可选)"
                  rows={2}
                  className="w-full px-2 py-1.5 rounded-lg text-[12px] outline-none resize-y"
                  style={inputStyle}
                />
              </div>
            ))
          )}
        </div>
      )}

      {/* ── 高级配置开关 ── */}
      {template !== 'none' && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-[11px] inline-flex items-center gap-1"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {showAdvanced ? '▾' : '▸'} 高级配置(滚动模式 / 展开折叠面板)
          </button>
          {showAdvanced && (
            <div
              className="mt-2 grid gap-3"
              style={{
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              }}
            >
              <Field label="滚动模式" hint="目标元素如何滚到视口">
                <select
                  value={a.scroll ?? 'center'}
                  onChange={(e) =>
                    patch({
                      scroll: e.target.value as DailyTipAutoAction['scroll'],
                    })
                  }
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none"
                  style={inputStyle}
                >
                  <option value="center">center(居中)</option>
                  <option value="top">top(顶部对齐)</option>
                  <option value="none">none(不滚动)</option>
                </select>
              </Field>
              <Field
                label="先点击展开 (Expand)"
                hint="目标在折叠面板里时,先点这个 selector 把面板打开"
              >
                <input
                  type="text"
                  value={a.expand ?? ''}
                  onChange={(e) => patch({ expand: e.target.value || null })}
                  placeholder="[data-tour-id=xxx-expand]"
                  className="w-full px-2 py-1.5 rounded-lg text-[13px] outline-none font-mono"
                  style={inputStyle}
                />
              </Field>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatChip({ label, value, color, bg }: { label: string; value: number; color: string; bg: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full"
      style={{ background: bg, color }}
    >
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </span>
  );
}
