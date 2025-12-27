import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { getAdminPromptStages, putAdminPromptStages, resetAdminPromptStages } from '@/services';
import type { PromptStageItem, PromptStageSettings } from '@/services/contracts/promptStages';
import { RefreshCw, Save, RotateCcw, AlertTriangle, Plus, Trash2, ArrowUp, ArrowDown, Copy } from 'lucide-react';

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type RoleKey = 'pm' | 'dev' | 'qa';

function normalizeText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function fmtDateTime(v?: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

function normalizeStages(stages: PromptStageItem[] | null | undefined): PromptStageItem[] {
  const src = Array.isArray(stages) ? stages : [];
  const out: PromptStageItem[] = [];

  for (let i = 0; i < src.length; i += 1) {
    const raw = (src[i] ?? {}) as Partial<PromptStageItem>;
    const order = typeof raw.order === 'number' && Number.isFinite(raw.order) && raw.order > 0
      ? raw.order
      : typeof raw.step === 'number' && Number.isFinite(raw.step) && raw.step > 0
        ? raw.step
        : i + 1;

    const stageKeyRaw = normalizeText(raw.stageKey).trim();
    const stageKey = stageKeyRaw || `legacy-step-${order}`;

    out.push({
      stageKey,
      order,
      step: typeof raw.step === 'number' && Number.isFinite(raw.step) && raw.step > 0 ? raw.step : order,
      pm: {
        title: normalizeText(raw.pm?.title),
        promptTemplate: normalizeText(raw.pm?.promptTemplate),
      },
      dev: {
        title: normalizeText(raw.dev?.title),
        promptTemplate: normalizeText(raw.dev?.promptTemplate),
      },
      qa: {
        title: normalizeText(raw.qa?.title),
        promptTemplate: normalizeText(raw.qa?.promptTemplate),
      },
    });
  }

  // 排序 + 去重（去重只用于容错展示；正常应由后端校验保证）
  out.sort((a, b) => a.order - b.order);
  const seen = new Map<string, number>();
  for (const s of out) {
    const c = seen.get(s.stageKey) ?? 0;
    if (c > 0) {
      s.stageKey = `${s.stageKey}-dup-${c}`;
    }
    seen.set(s.stageKey, c + 1);
  }

  // order 兜底：确保正整数
  for (let i = 0; i < out.length; i += 1) {
    if (!Number.isFinite(out[i].order) || out[i].order <= 0) out[i].order = i + 1;
    out[i].step = out[i].order;
  }

  return out;
}

function stableKey(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(v));
}

function validateStages(stages: PromptStageItem[]) {
  if (!Array.isArray(stages) || stages.length === 0) return { ok: false, message: '至少需要 1 个阶段' };

  const keySet = new Set<string>();
  const orderSet = new Set<number>();
  for (const s of stages) {
    const key = normalizeText(s.stageKey).trim();
    if (!key) return { ok: false, message: 'stageKey 不能为空' };
    if (keySet.has(key)) return { ok: false, message: `stageKey 重复：${key}` };
    keySet.add(key);

    const order = Number(s.order);
    if (!Number.isFinite(order) || order <= 0) return { ok: false, message: `order 必须为正整数（stageKey=${key}）` };
    if (orderSet.has(order)) return { ok: false, message: `order 重复：${order}` };
    orderSet.add(order);

    const pm = s.pm;
    const dev = s.dev;
    const qa = s.qa;
    if (!normalizeText(pm?.title).trim() || !normalizeText(pm?.promptTemplate).trim()) return { ok: false, message: `order=${order}：PM 的 title/promptTemplate 不能为空` };
    if (!normalizeText(dev?.title).trim() || !normalizeText(dev?.promptTemplate).trim()) return { ok: false, message: `order=${order}：DEV 的 title/promptTemplate 不能为空` };
    if (!normalizeText(qa?.title).trim() || !normalizeText(qa?.promptTemplate).trim()) return { ok: false, message: `order=${order}：QA 的 title/promptTemplate 不能为空` };
  }
  return { ok: true, message: '' };
}

export default function PromptStagesPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [isOverridden, setIsOverridden] = useState(false);
  const [settings, setSettings] = useState<PromptStageSettings | null>(null);
  const [baselineSig, setBaselineSig] = useState<string>('');

  const [activeStageKey, setActiveStageKey] = useState<string>('');
  const [activeRole, setActiveRole] = useState<RoleKey>('pm');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await getAdminPromptStages();
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setIsOverridden(!!res.data.isOverridden);
      setSettings(res.data.settings);
      setBaselineSig(stableKey({ stages: normalizeStages(res.data.settings?.stages) }));
      const ns = normalizeStages(res.data.settings?.stages);
      const nextKey = ns[0]?.stageKey ?? '';
      setActiveStageKey((prev) => (prev && ns.some((x) => x.stageKey === prev) ? prev : nextKey));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stages = useMemo(() => normalizeStages(settings?.stages), [settings?.stages]);
  const stage = useMemo(() => stages.find((s) => s.stageKey === activeStageKey) ?? stages[0], [stages, activeStageKey]);

  const roleLabel = useMemo(() => {
    if (activeRole === 'pm') return '产品经理（PM）';
    if (activeRole === 'dev') return '开发（DEV）';
    return '测试（QA）';
  }, [activeRole]);

  const roleData = useMemo(() => {
    if (!stage) return { title: '', promptTemplate: '' };
    return activeRole === 'dev' ? stage.dev : activeRole === 'qa' ? stage.qa : stage.pm;
  }, [stage, activeRole]);

  const currentSig = useMemo(() => stableKey({ stages }), [stages]);
  const isDirty = useMemo(() => !!baselineSig && baselineSig !== currentSig, [baselineSig, currentSig]);
  const validation = useMemo(() => validateStages(stages), [stages]);

  const setRoleField = (field: 'title' | 'promptTemplate', value: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const nextStages = normalizeStages(prev.stages).map((s) => {
        if (s.stageKey !== activeStageKey) return s;
        const next = { ...s, pm: { ...s.pm }, dev: { ...s.dev }, qa: { ...s.qa } };
        const target = activeRole === 'dev' ? next.dev : activeRole === 'qa' ? next.qa : next.pm;
        if (field === 'title') target.title = value;
        else target.promptTemplate = value;
        return next;
      });
      return { ...prev, stages: nextStages };
    });
  };

  const compactOrders = (xs: PromptStageItem[]) => {
    const sorted = [...xs].sort((a, b) => a.order - b.order);
    return sorted.map((s, idx) => ({ ...s, order: idx + 1, step: idx + 1 }));
  };

  const addStage = () => {
    const key = safeIdempotencyKey();
    setSettings((prev) => {
      const base = normalizeStages(prev?.stages);
      const maxOrder = base.reduce((m, x) => Math.max(m, x.order), 0);
      const next: PromptStageItem = {
        stageKey: `stage-${key}`,
        order: maxOrder + 1,
        step: maxOrder + 1,
        pm: { title: '新阶段', promptTemplate: '请用 Markdown 输出：' },
        dev: { title: '新阶段', promptTemplate: '请用 Markdown 输出：' },
        qa: { title: '新阶段', promptTemplate: '请用 Markdown 输出：' },
      };
      const merged = compactOrders([...base, next]);
      // 保持 UpdatedAt/id 不变（保存后由后端回填）
      if (prev) return { ...prev, stages: merged };
      const created: PromptStageSettings = {
        id: 'global',
        updatedAt: new Date().toISOString(),
        stages: merged,
      };
      return created;
    });
    // 等 state 更新后再切换 active
    setActiveStageKey((_) => `stage-${key}`);
  };

  const removeStage = (stageKey: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const base = normalizeStages(prev.stages).filter((x) => x.stageKey !== stageKey);
      const merged = compactOrders(base);
      return { ...prev, stages: merged };
    });
    setActiveStageKey((prev) => {
      if (prev !== stageKey) return prev;
      const rest = stages.filter((x) => x.stageKey !== stageKey).sort((a, b) => a.order - b.order);
      return rest[0]?.stageKey ?? '';
    });
  };

  const moveStage = (stageKey: string, dir: 'up' | 'down') => {
    setSettings((prev) => {
      if (!prev) return prev;
      const base = normalizeStages(prev.stages).sort((a, b) => a.order - b.order);
      const idx = base.findIndex((x) => x.stageKey === stageKey);
      if (idx < 0) return prev;
      const j = dir === 'up' ? idx - 1 : idx + 1;
      if (j < 0 || j >= base.length) return prev;
      const a = base[idx];
      const b = base[j];
      // swap order
      const next = base.map((x) => {
        if (x.stageKey === a.stageKey) return { ...x, order: b.order, step: b.order };
        if (x.stageKey === b.stageKey) return { ...x, order: a.order, step: a.order };
        return x;
      });
      return { ...prev, stages: next.sort((x, y) => x.order - y.order) };
    });
  };

  const copyStageKey = async (k: string) => {
    try {
      await navigator.clipboard.writeText(k);
      setMsg('已复制 stageKey');
      setTimeout(() => setMsg(null), 900);
    } catch {
      // ignore
    }
  };

  const save = async () => {
    if (!settings) return;
    if (!validation.ok) {
      setErr(validation.message);
      return;
    }
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const idem = safeIdempotencyKey();
      const trimmedStages = [...stages]
        .sort((a, b) => a.order - b.order)
        .map((s) => ({
          ...s,
          stageKey: s.stageKey.trim(),
          order: Number(s.order),
          step: Number(s.order),
          pm: { title: s.pm.title.trim(), promptTemplate: s.pm.promptTemplate.trim() },
          dev: { title: s.dev.title.trim(), promptTemplate: s.dev.promptTemplate.trim() },
          qa: { title: s.qa.title.trim(), promptTemplate: s.qa.promptTemplate.trim() },
        }));
      const res = await putAdminPromptStages({ stages: trimmedStages }, idem);
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '保存失败'}`);
        return;
      }
      setSettings(res.data.settings);
      setIsOverridden(true);
      setBaselineSig(stableKey({ stages: normalizeStages(res.data.settings?.stages) }));
      setMsg('已保存（所有客户端将逐步生效，通常 ≤ 5 分钟）');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const idem = safeIdempotencyKey();
      const res = await resetAdminPromptStages(idem);
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '恢复默认失败'}`);
        return;
      }
      setMsg('已恢复为系统默认提示词');
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <Card className="p-4" variant="gold">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>提示词管理</div>
              {isDirty && (
                <Badge variant="featured" size="sm" icon={<AlertTriangle size={10} />}>
                  未保存
                </Badge>
              )}
            </div>
            <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              按阶段（可增删/排序）与角色（PM/DEV/QA）配置阶段名称与阶段提示词模板；将影响 Desktop 阶段展示、Guide 模板与问答 system prompt。
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant={isOverridden ? 'success' : 'subtle'}>{isOverridden ? '已覆盖默认' : '使用默认'}</Badge>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>UpdatedAt：{fmtDateTime(settings?.updatedAt)}</div>
              {!validation.ok && (
                <div className="text-xs" style={{ color: 'rgba(255,120,120,0.95)' }}>
                  {validation.message}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="sm" onClick={load} disabled={loading || saving}>
              <RefreshCw size={16} />
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={loading || saving || !settings || !isDirty || !validation.ok}
              title={!isDirty ? '未修改无需保存' : !validation.ok ? '请先补齐必填项' : '保存'}
            >
              <Save size={16} />
              保存
            </Button>
            <ConfirmTip
              title="恢复默认？"
              description="将删除管理员覆盖配置，所有阶段提示词回落到系统默认（不可恢复覆盖内容）。"
              confirmText="确认恢复默认"
              onConfirm={reset}
              disabled={loading || saving}
              side="top"
              align="end"
            >
              <Button variant="danger" size="sm" disabled={loading || saving}>
                <RotateCcw size={16} />
                恢复默认
              </Button>
            </ConfirmTip>
          </div>
        </div>
      </Card>

      {err && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(255,120,120,0.95)' }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(34,197,94,0.95)' }}>
          {msg}
        </div>
      )}

      <div className="grid gap-4 min-h-0" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
        <Card className="p-4 min-h-0 flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>阶段总览</div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                共 {stages.length} 个阶段（点击切换；支持新增/删除/排序）
              </div>
            </div>
            <Button variant="secondary" size="xs" onClick={addStage} disabled={loading || saving}>
              <Plus size={14} />
              新增
            </Button>
          </div>
          <div className="mt-3 flex-1 min-h-0 overflow-auto grid gap-2">
            {[...stages].sort((a, b) => a.order - b.order).map((s, idx, arr) => {
              const active = s.stageKey === (activeStageKey || arr[0]?.stageKey || '');
              const pmTitle = normalizeText(s.pm?.title).trim() || `阶段 ${s.order}`;
              const devTitle = normalizeText(s.dev?.title).trim() || `阶段 ${s.order}`;
              const qaTitle = normalizeText(s.qa?.title).trim() || `阶段 ${s.order}`;
              return (
                <button
                  key={s.stageKey}
                  type="button"
                  onClick={() => setActiveStageKey(s.stageKey)}
                  className="w-full text-left rounded-[14px] px-3 py-3 transition-colors"
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent-gold) 10%, var(--bg-input))' : 'var(--bg-input)',
                    border: active ? '1px solid color-mix(in srgb, var(--accent-gold) 42%, var(--border-default))' : '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="shrink-0 inline-flex items-center justify-center font-extrabold"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 10,
                        color: active ? '#1a1206' : 'var(--text-secondary)',
                        background: active ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.06)',
                        border: active ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.10)',
                        boxShadow: active ? 'var(--shadow-gold)' : 'none',
                      }}
                    >
                      {s.order}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {activeRole === 'dev' ? devTitle : activeRole === 'qa' ? qaTitle : pmTitle}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          stageKey：{s.stageKey}
                        </div>
                        <div className="shrink-0 flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void copyStageKey(s.stageKey); }}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.04)' }}
                            aria-label="复制 stageKey"
                            title="复制 stageKey"
                          >
                            <Copy size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); moveStage(s.stageKey, 'up'); }}
                            disabled={idx === 0}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[10px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.04)' }}
                            aria-label="上移"
                            title="上移"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); moveStage(s.stageKey, 'down'); }}
                            disabled={idx === arr.length - 1}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[10px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.04)' }}
                            aria-label="下移"
                            title="下移"
                          >
                            <ArrowDown size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 grid gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <div className="truncate"><span style={{ color: 'rgba(242,213,155,0.92)' }}>PM</span> · {pmTitle}</div>
                        <div className="truncate"><span style={{ color: 'rgba(124,252,0,0.72)' }}>DEV</span> · {devTitle}</div>
                        <div className="truncate"><span style={{ color: 'rgba(255,255,255,0.70)' }}>QA</span> · {qaTitle}</div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="p-4 min-h-0 flex flex-col" variant="default">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                编辑器：order {stage?.order ?? 0} · {roleLabel}
              </div>
              {stage?.stageKey && (
                <div className="mt-1 text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                  <span className="truncate">stageKey：{stage.stageKey}</span>
                  <button
                    type="button"
                    onClick={() => void copyStageKey(stage.stageKey)}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                    style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.04)' }}
                    aria-label="复制 stageKey"
                    title="复制 stageKey"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )}
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                阶段提示词用于“聚焦指令”：引导讲解会严格使用；问答会作为背景约束（不要生硬照抄）。
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <ConfirmTip
                title="删除阶段？"
                description="将删除当前阶段（不可恢复）。建议先保存导出或复制内容。"
                confirmText="确认删除"
                onConfirm={() => {
                  if (stage?.stageKey) removeStage(stage.stageKey);
                }}
                disabled={loading || saving || !stage?.stageKey || stages.length <= 1}
                side="top"
                align="end"
              >
                <Button variant="danger" size="xs" disabled={loading || saving || !stage?.stageKey || stages.length <= 1}>
                  <Trash2 size={14} />
                  删除
                </Button>
              </ConfirmTip>
              <Button variant={activeRole === 'pm' ? 'primary' : 'secondary'} size="xs" onClick={() => setActiveRole('pm')}>
                PM
              </Button>
              <Button variant={activeRole === 'dev' ? 'primary' : 'secondary'} size="xs" onClick={() => setActiveRole('dev')}>
                DEV
              </Button>
              <Button variant={activeRole === 'qa' ? 'primary' : 'secondary'} size="xs" onClick={() => setActiveRole('qa')}>
                QA
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 min-h-0">
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>阶段名称（title）</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>用于 Desktop 阶段按钮展示</div>
              </div>
              <input
                value={roleData.title ?? ''}
                onChange={(e) => setRoleField('title', e.target.value)}
                placeholder="例如：项目背景与问题定义"
                className="mt-2 w-full rounded-[12px] px-3 py-2 text-sm outline-none"
                style={{
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>阶段提示词（promptTemplate）</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  字符：{(roleData.promptTemplate ?? '').length.toLocaleString()}
                </div>
              </div>
              <textarea
                value={roleData.promptTemplate ?? ''}
                onChange={(e) => setRoleField('promptTemplate', e.target.value)}
                placeholder="建议包含：关注点、输出结构、边界约束等（支持 Markdown 指令/结构要求）"
                className="mt-2 flex-1 min-h-[340px] w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
                style={{
                  border: '1px solid var(--border-subtle)',
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.03) 100%)',
                  color: 'var(--text-primary)',
                  lineHeight: 1.6,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
              />
            </div>

            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              小建议：避免把“用户必须如何提问”写进阶段提示词；更推荐写“本阶段要关注什么、按什么结构输出、缺失要如何标注”。保存后约 5 分钟全端生效（后端有缓存）。
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}


