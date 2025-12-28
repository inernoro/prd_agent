import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Dialog } from '@/components/ui/Dialog';
import { getAdminPromptStages, putAdminPromptStages, resetAdminPromptStages } from '@/services';
import type { PromptStageEntry, PromptStageSettings } from '@/services/contracts/promptStages';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { RefreshCw, Save, RotateCcw, AlertTriangle, Plus, Trash2, Copy, Sparkles, Square } from 'lucide-react';

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type RoleKey = 'pm' | 'dev' | 'qa';
type RoleEnum = 'PM' | 'DEV' | 'QA';

function roleKeyToEnum(r: RoleKey): RoleEnum {
  if (r === 'dev') return 'DEV';
  if (r === 'qa') return 'QA';
  return 'PM';
}

function roleEnumToKey(r: RoleEnum): RoleKey {
  if (r === 'DEV') return 'dev';
  if (r === 'QA') return 'qa';
  return 'pm';
}

function roleKeyToSuffix(r: RoleKey) {
  return r === 'dev' ? 'dev' : r === 'qa' ? 'qa' : 'pm';
}

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

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

type PromptOptimizeStreamEvent = {
  type: 'start' | 'delta' | 'done' | 'error';
  content?: string;
  errorCode?: string;
  errorMessage?: string;
};

function normalizeStages(stages: PromptStageEntry[] | null | undefined): PromptStageEntry[] {
  const src = Array.isArray(stages) ? stages : [];
  const out: PromptStageEntry[] = [];

  for (let i = 0; i < src.length; i += 1) {
    const raw = (src[i] ?? {}) as Partial<PromptStageEntry>;
    const role = (normalizeText((raw as { role?: unknown }).role).toUpperCase() as RoleEnum) || 'PM';
    if (role !== 'PM' && role !== 'DEV' && role !== 'QA') continue;
    const order = typeof raw.order === 'number' && Number.isFinite(raw.order) && raw.order > 0 ? raw.order : 1;
    const stageKey = normalizeText(raw.stageKey).trim();
    if (!stageKey) continue;
    out.push({
      stageKey,
      role,
      order,
      title: normalizeText(raw.title),
      promptTemplate: normalizeText(raw.promptTemplate),
    });
  }

  // 排序：role 内 order
  return out.sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
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

function validateStages(stages: PromptStageEntry[]) {
  if (!Array.isArray(stages) || stages.length === 0) return { ok: false, message: '至少需要 1 个阶段' };

  const keySet = new Set<string>();
  const ordersByRole = new Map<RoleEnum, Set<number>>();
  for (const s of stages) {
    const key = normalizeText(s.stageKey).trim();
    if (!key) return { ok: false, message: 'stageKey 不能为空' };
    if (keySet.has(key)) return { ok: false, message: `stageKey 重复：${key}` };
    keySet.add(key);

    const role = (normalizeText((s as { role?: unknown }).role).toUpperCase() as RoleEnum) || 'PM';
    if (role !== 'PM' && role !== 'DEV' && role !== 'QA') return { ok: false, message: `role 非法（stageKey=${key}）` };

    const order = Number(s.order);
    if (!Number.isFinite(order) || order <= 0) return { ok: false, message: `order 必须为正整数（stageKey=${key}）` };
    const set = ordersByRole.get(role) ?? new Set<number>();
    if (set.has(order)) return { ok: false, message: `同一 role 下 order 重复：${role} / ${order}` };
    set.add(order);
    ordersByRole.set(role, set);

    if (!normalizeText(s.title).trim()) return { ok: false, message: `title 不能为空（stageKey=${key}）` };
    // promptTemplate 可为空（代表该阶段不注入提示词）
  }

  return { ok: true, message: '' };
}

export default function PromptStagesPage() {
  const token = useAuthStore((s) => s.token);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [isOverridden, setIsOverridden] = useState(false);
  const [settings, setSettings] = useState<PromptStageSettings | null>(null);
  const [baselineSig, setBaselineSig] = useState<string>('');

  const [activeStageKey, setActiveStageKey] = useState<string>('');
  const [activeRole, setActiveRole] = useState<RoleKey>('pm');

  // 提示词优化（魔法棒）
  const [optOpen, setOptOpen] = useState(false);
  const [optBusy, setOptBusy] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [optText, setOptText] = useState<string>('');
  const [optOriginal, setOptOriginal] = useState<string>('');
  const optAbortRef = useRef<AbortController | null>(null);

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
  const roleEnum = useMemo(() => roleKeyToEnum(activeRole), [activeRole]);
  const roleStages = useMemo(
    () => stages.filter((s) => s.role === roleEnum).sort((a, b) => a.order - b.order),
    [stages, roleEnum]
  );
  const stage = useMemo(
    () => roleStages.find((s) => s.stageKey === activeStageKey) ?? roleStages[0] ?? null,
    [roleStages, activeStageKey]
  );

  const roleLabel = useMemo(() => {
    if (activeRole === 'pm') return '产品经理（PM）';
    if (activeRole === 'dev') return '开发（DEV）';
    return '测试（QA）';
  }, [activeRole]);

  // 角色切换时：若当前 stageKey 不属于该角色，自动切到该角色第一项
  useEffect(() => {
    if (!roleStages.length) {
      setActiveStageKey('');
      return;
    }
    if (activeStageKey && roleStages.some((x) => x.stageKey === activeStageKey)) return;
    setActiveStageKey(roleStages[0].stageKey);
  }, [roleStages, activeStageKey]);

  const currentSig = useMemo(() => stableKey({ stages }), [stages]);
  const isDirty = useMemo(() => !!baselineSig && baselineSig !== currentSig, [baselineSig, currentSig]);
  const validation = useMemo(() => validateStages(stages), [stages]);

  const setStageField = (field: 'title' | 'promptTemplate', value: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const nextStages = normalizeStages(prev.stages).map((s) => {
        if (s.stageKey !== activeStageKey) return s;
        const next = { ...s };
        if (field === 'title') next.title = value;
        else next.promptTemplate = value;
        return next;
      });
      return { ...prev, stages: nextStages };
    });
  };

  const addStage = () => {
    const key = safeIdempotencyKey();
    setSettings((prev) => {
      const base = normalizeStages(prev?.stages);
      const role = roleEnum;
      const inRole = base.filter((x) => x.role === role).sort((a, b) => a.order - b.order);
      const maxOrder = inRole.reduce((m, x) => Math.max(m, x.order), 0);
      const next: PromptStageEntry = {
        stageKey: `stage-${roleKeyToSuffix(roleEnumToKey(role))}-${key}`,
        role,
        order: maxOrder + 1,
        title: '新阶段',
        promptTemplate: '',
      };
      const mergedRole = [...inRole, next].map((x, idx) => ({ ...x, order: idx + 1 }));
      const merged = base
        .filter((x) => x.role !== role)
        .concat(mergedRole)
        .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
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
    setActiveStageKey((_) => `stage-${roleKeyToSuffix(roleEnumToKey(roleEnum))}-${key}`);
  };

  const removeStage = (stageKey: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const base = normalizeStages(prev.stages);
      const removed = base.find((x) => x.stageKey === stageKey) ?? null;
      const nextAll = base.filter((x) => x.stageKey !== stageKey);
      if (!removed) return { ...prev, stages: nextAll };
      // 仅在该 role 内重排 order
      const role = removed.role;
      const roleList = nextAll.filter((x) => x.role === role).sort((a, b) => a.order - b.order).map((x, idx) => ({ ...x, order: idx + 1 }));
      const merged = nextAll.filter((x) => x.role !== role).concat(roleList).sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
      return { ...prev, stages: merged };
    });
    setActiveStageKey((prev) => {
      if (prev !== stageKey) return prev;
      const rest = roleStages.filter((x) => x.stageKey !== stageKey).sort((a, b) => a.order - b.order);
      return rest[0]?.stageKey ?? '';
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

  const openOptimize = () => {
    const raw = (stage?.promptTemplate ?? '').trim();
    setOptOriginal(raw);
    setOptText('');
    setOptError(null);
    setOptOpen(true);
  };

  const cancelOptimize = () => {
    try {
      optAbortRef.current?.abort();
    } catch {
      // ignore
    }
    optAbortRef.current = null;
    setOptBusy(false);
  };

  const startOptimize = async () => {
    if (!token) {
      setOptError('未登录或 Token 缺失');
      return;
    }
    const promptTemplate = (stage?.promptTemplate ?? '').trim();
    if (!promptTemplate) {
      setOptError('当前提示词为空，无法优化');
      return;
    }

    cancelOptimize();
    const ac = new AbortController();
    optAbortRef.current = ac;
    setOptBusy(true);
    setOptError(null);
    setOptText('');
    setOptOriginal(promptTemplate);

    let res: Response;
    try {
      const url = joinUrl(getApiBaseUrl(), '/api/v1/admin/prompt-stages/optimize/stream');
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          stageKey: stage?.stageKey ?? null,
          order: stage?.order ?? null,
          role: roleEnum,
          title: stage?.title ?? null,
          promptTemplate,
          mode: 'strict',
        }),
        signal: ac.signal,
      });
    } catch (e) {
      setOptBusy(false);
      optAbortRef.current = null;
      const m = e instanceof Error ? e.message : '网络错误';
      setOptError(`请求失败：${m}`);
      return;
    }

    if (!res.ok) {
      setOptBusy(false);
      optAbortRef.current = null;
      const t = await res.text().catch(() => '');
      setOptError(t || `HTTP ${res.status} ${res.statusText}`);
      return;
    }

    try {
      await readSseStream(
        res,
        (evt) => {
          if (!evt.data) return;
          try {
            const obj = JSON.parse(evt.data) as PromptOptimizeStreamEvent;
            if (obj.type === 'delta' && obj.content) {
              setOptText((prev) => prev + obj.content);
            } else if (obj.type === 'error') {
              setOptError(obj.errorMessage || '优化失败');
              setOptBusy(false);
              optAbortRef.current = null;
            } else if (obj.type === 'done') {
              setOptBusy(false);
              optAbortRef.current = null;
            }
          } catch {
            // ignore
          }
        },
        ac.signal
      );
    } finally {
      // 若中途被 abort，readSseStream 会退出；这里兜底结束状态
      if (ac.signal.aborted) {
        setOptBusy(false);
        optAbortRef.current = null;
      }
    }
  };

  const applyOptimized = () => {
    const next = (optText || '').trim();
    if (!next) return;
    setStageField('promptTemplate', next);
    setOptOpen(false);
    setMsg('已替换为优化后的提示词（别忘了点保存）');
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
        .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)))
        .map((s) => ({
          stageKey: s.stageKey.trim(),
          role: s.role,
          order: Number(s.order),
          title: (s.title ?? '').trim(),
          promptTemplate: (s.promptTemplate ?? '').trim(),
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
            <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>阶段总览</div>
            <div className="shrink-0">
              <Button variant="secondary" size="xs" onClick={addStage} disabled={loading || saving}>
                <Plus size={14} />
                新增
              </Button>
            </div>
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            共 {roleStages.length} 个阶段（{roleEnum}；支持新增/删除/排序/切换）
          </div>
          <div className="mt-3 flex-1 min-h-0 overflow-auto grid gap-2">
            {roleStages.map((s) => {
              const active = s.stageKey === (activeStageKey || roleStages[0]?.stageKey || '');
              return (
                <div
                  key={s.stageKey}
                  className="rounded-[14px] transition-colors"
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent-gold) 10%, var(--bg-input))' : 'var(--bg-input)',
                    border: active ? '1px solid color-mix(in srgb, var(--accent-gold) 42%, var(--border-default))' : '1px solid var(--border-subtle)',
                  }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveStageKey(s.stageKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveStageKey(s.stageKey);
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const from = e.dataTransfer.getData('text/plain');
                      const to = s.stageKey;
                      if (!from || from === to) return;
                      setSettings((prev) => {
                        if (!prev) return prev;
                        const all = normalizeStages(prev.stages);
                        const list = all.filter((x) => x.role === roleEnum).sort((a, b) => a.order - b.order);
                        const fromIdx = list.findIndex((x) => x.stageKey === from);
                        const toIdx = list.findIndex((x) => x.stageKey === to);
                        if (fromIdx < 0 || toIdx < 0) return prev;
                        const moved = [...list];
                        const [item] = moved.splice(fromIdx, 1);
                        moved.splice(toIdx, 0, item);
                        const renumbered = moved.map((x, i) => ({ ...x, order: i + 1 }));
                        const merged = all
                          .filter((x) => x.role !== roleEnum)
                          .concat(renumbered)
                          .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
                        return { ...prev, stages: merged };
                      });
                    }}
                    className="w-full text-left px-3 py-3 outline-none"
                    title={normalizeText(s.title).trim() || `阶段 ${s.order}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          try {
                            e.dataTransfer.setData('text/plain', s.stageKey);
                            e.dataTransfer.effectAllowed = 'move';
                          } catch {
                            // ignore
                          }
                        }}
                        className="shrink-0 inline-flex items-center justify-center font-extrabold"
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 10,
                          color: active ? '#1a1206' : 'var(--text-secondary)',
                          background: active ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.06)',
                          border: active ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.10)',
                          boxShadow: active ? 'var(--shadow-gold)' : 'none',
                          cursor: 'grab',
                        }}
                        title="拖拽排序"
                      >
                        {s.order}
                      </span>
                      <div className="text-sm font-semibold truncate min-w-0 flex-1" style={{ color: 'var(--text-primary)' }}>
                        {normalizeText(s.title).trim() || `阶段 ${s.order}`}
                      </div>
                    </div>
                  </div>
                </div>
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
                disabled={loading || saving || !stage?.stageKey || roleStages.length <= 1}
                side="top"
                align="end"
              >
                <Button variant="danger" size="xs" disabled={loading || saving || !stage?.stageKey || roleStages.length <= 1}>
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
                value={stage?.title ?? ''}
                onChange={(e) => setStageField('title', e.target.value)}
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
                  字符：{(stage?.promptTemplate ?? '').length.toLocaleString()}
                </div>
              </div>
              <div className="mt-2 flex-1 min-h-[340px] relative">
                <textarea
                  value={stage?.promptTemplate ?? ''}
                  onChange={(e) => setStageField('promptTemplate', e.target.value)}
                  placeholder="建议包含：关注点、输出结构、边界约束等（支持 Markdown 指令/结构要求）"
                  className="h-full w-full rounded-[14px] px-3 py-3 pr-12 text-sm outline-none resize-none"
                  style={{
                    border: '1px solid var(--border-subtle)',
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.03) 100%)',
                    color: 'var(--text-primary)',
                    lineHeight: 1.6,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (optBusy) {
                      cancelOptimize();
                      return;
                    }
                    openOptimize();
                    void startOptimize();
                  }}
                  className="absolute bottom-2 right-2 h-9 w-9 inline-flex items-center justify-center rounded-[12px] transition-colors"
                  style={{
                    background: optBusy ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.06)',
                    border: optBusy ? '1px solid rgba(239,68,68,0.28)' : '1px solid rgba(255,255,255,0.12)',
                    color: optBusy ? 'rgba(239,68,68,0.95)' : 'var(--text-secondary)',
                  }}
                  title={optBusy ? '停止优化' : '魔法棒：优化提示词（大模型）'}
                  aria-label={optBusy ? '停止优化' : '优化提示词'}
                >
                  {optBusy ? <Square size={16} /> : <Sparkles size={16} />}
                </button>
              </div>
            </div>

            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              小建议：避免把“用户必须如何提问”写进阶段提示词；更推荐写“本阶段要关注什么、按什么结构输出、缺失要如何标注”。保存后约 5 分钟全端生效（后端有缓存）。
            </div>
          </div>
        </Card>
      </div>

      <Dialog
        open={optOpen}
        onOpenChange={(o) => {
          if (!o) cancelOptimize();
          setOptOpen(o);
        }}
        title="提示词优化（魔法棒）"
        description="大模型会在不改变意图的前提下，让提示词更清晰、更可执行，并尽量保留占位符/约束。先预览再替换。"
        maxWidth={1040}
        content={
          <div className="min-h-0 flex flex-col gap-4">
            {optError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(0,0,0,0.20)',
                  color: 'rgba(255,120,120,0.95)',
                }}
              >
                {optError}
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                当前：role={roleEnum} · order={stage?.order ?? '—'} · stageKey={stage?.stageKey ?? '—'}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void startOptimize()} disabled={optBusy}>
                  <Sparkles size={16} />
                  重新优化
                </Button>
                <Button variant="danger" size="sm" onClick={cancelOptimize} disabled={!optBusy}>
                  <Square size={16} />
                  停止
                </Button>
                <Button variant="primary" size="sm" onClick={applyOptimized} disabled={optBusy || !(optText || '').trim()}>
                  <Save size={16} />
                  替换到编辑器
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    const t = (optText || '').trim();
                    if (!t) return;
                    try {
                      await navigator.clipboard.writeText(t);
                      setMsg('已复制优化结果');
                    } catch {
                      // ignore
                    }
                  }}
                  disabled={optBusy || !(optText || '').trim()}
                >
                  <Copy size={16} />
                  复制
                </Button>
              </div>
            </div>

            <div className="grid gap-4 min-h-0" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Card className="p-4 min-h-0 flex flex-col">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>原文</div>
                <textarea
                  value={optOriginal}
                  readOnly
                  className="mt-3 flex-1 min-h-[360px] w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
                  style={{
                    border: '1px solid var(--border-subtle)',
                    background: 'rgba(255,255,255,0.03)',
                    color: 'var(--text-primary)',
                    lineHeight: 1.6,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                />
              </Card>

              <Card className="p-4 min-h-0 flex flex-col" variant="gold">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>优化结果（流式）</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    字符：{(optText || '').length.toLocaleString()}
                  </div>
                </div>
                <textarea
                  value={optText}
                  readOnly
                  className="mt-3 flex-1 min-h-[360px] w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
                  style={{
                    border: '1px solid var(--border-subtle)',
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.03) 100%)',
                    color: 'var(--text-primary)',
                    lineHeight: 1.6,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                />
              </Card>
            </div>
          </div>
        }
      />
    </div>
  );
}


