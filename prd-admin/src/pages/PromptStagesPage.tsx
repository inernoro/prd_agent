import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Dialog } from '@/components/ui/Dialog';
import { getAdminPrompts, putAdminPrompts, resetAdminPrompts } from '@/services';
import type { PromptEntry, PromptSettings } from '@/services/contracts/prompts';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { RefreshCw, Save, RotateCcw, AlertTriangle, Plus, Trash2, Copy, Sparkles, Square, Rocket } from 'lucide-react';

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

function normalizePrompts(prompts: PromptEntry[] | null | undefined): PromptEntry[] {
  const src = Array.isArray(prompts) ? prompts : [];
  const out: PromptEntry[] = [];

  for (let i = 0; i < src.length; i += 1) {
    const raw = (src[i] ?? {}) as Partial<PromptEntry>;
    const role = (normalizeText((raw as { role?: unknown }).role).toUpperCase() as RoleEnum) || 'PM';
    if (role !== 'PM' && role !== 'DEV' && role !== 'QA') continue;
    const order = typeof raw.order === 'number' && Number.isFinite(raw.order) && raw.order > 0 ? raw.order : 1;
    const promptKey = normalizeText(raw.promptKey).trim();
    if (!promptKey) continue;
    out.push({
      promptKey,
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

function validatePrompts(prompts: PromptEntry[]) {
  if (!Array.isArray(prompts) || prompts.length === 0) return { ok: false, message: '至少需要 1 个提示词' };

  const keySet = new Set<string>();
  const ordersByRole = new Map<RoleEnum, Set<number>>();
  for (const p of prompts) {
    const key = normalizeText(p.promptKey).trim();
    if (!key) return { ok: false, message: 'promptKey 不能为空' };
    if (keySet.has(key)) return { ok: false, message: `promptKey 重复：${key}` };
    keySet.add(key);

    const role = (normalizeText((p as { role?: unknown }).role).toUpperCase() as RoleEnum) || 'PM';
    if (role !== 'PM' && role !== 'DEV' && role !== 'QA') return { ok: false, message: `role 非法（promptKey=${key}）` };

    const order = Number(p.order);
    if (!Number.isFinite(order) || order <= 0) return { ok: false, message: `order 必须为正整数（promptKey=${key}）` };
    const set = ordersByRole.get(role) ?? new Set<number>();
    if (set.has(order)) return { ok: false, message: `同一 role 下 order 重复：${role} / ${order}` };
    set.add(order);
    ordersByRole.set(role, set);

    if (!normalizeText(p.title).trim()) return { ok: false, message: `title 不能为空（promptKey=${key}）` };
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
  const [saveAnimKey, setSaveAnimKey] = useState<number>(0);

  const [isOverridden, setIsOverridden] = useState(false);
  const [settings, setSettings] = useState<PromptSettings | null>(null);
  const [baselineSig, setBaselineSig] = useState<string>('');

  const [activePromptKey, setActivePromptKey] = useState<string>('');
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
      const res = await getAdminPrompts();
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setIsOverridden(!!res.data.isOverridden);
      setSettings(res.data.settings);
      setBaselineSig(stableKey({ prompts: normalizePrompts(res.data.settings?.prompts) }));
      const np = normalizePrompts(res.data.settings?.prompts);
      const nextKey = np[0]?.promptKey ?? '';
      setActivePromptKey((prev) => (prev && np.some((x) => x.promptKey === prev) ? prev : nextKey));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prompts = useMemo(() => normalizePrompts(settings?.prompts), [settings?.prompts]);
  const roleEnum = useMemo(() => roleKeyToEnum(activeRole), [activeRole]);
  const roleStages = useMemo(
    () => prompts.filter((p) => p.role === roleEnum).sort((a, b) => a.order - b.order),
    [prompts, roleEnum]
  );
  const stage = useMemo(
    () => roleStages.find((p) => p.promptKey === activePromptKey) ?? roleStages[0] ?? null,
    [roleStages, activePromptKey]
  );

  const roleLabel = useMemo(() => {
    if (activeRole === 'pm') return '产品经理（PM）';
    if (activeRole === 'dev') return '开发（DEV）';
    return '测试（QA）';
  }, [activeRole]);

  // 角色切换时：若当前 promptKey 不属于该角色，自动切到该角色第一项
  useEffect(() => {
    if (!roleStages.length) {
      setActivePromptKey('');
      return;
    }
    if (activePromptKey && roleStages.some((x) => x.promptKey === activePromptKey)) return;
    setActivePromptKey(roleStages[0].promptKey);
  }, [roleStages, activePromptKey]);

  const currentSig = useMemo(() => stableKey({ prompts }), [prompts]);
  const isDirty = useMemo(() => !!baselineSig && baselineSig !== currentSig, [baselineSig, currentSig]);
  const validation = useMemo(() => validatePrompts(prompts), [prompts]);

  const setPromptField = (field: 'title' | 'promptTemplate', value: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const nextPrompts = normalizePrompts(prev.prompts).map((p) => {
        if (p.promptKey !== activePromptKey) return p;
        const next = { ...p };
        if (field === 'title') next.title = value;
        else next.promptTemplate = value;
        return next;
      });
      return { ...prev, prompts: nextPrompts };
    });
  };

  const addPrompt = () => {
    const key = safeIdempotencyKey();
    setSettings((prev) => {
      const base = normalizePrompts(prev?.prompts);
      const role = roleEnum;
      const inRole = base.filter((x) => x.role === role).sort((a, b) => a.order - b.order);
      const maxOrder = inRole.reduce((m, x) => Math.max(m, x.order), 0);
      const next: PromptEntry = {
        promptKey: `prompt-${roleKeyToSuffix(roleEnumToKey(role))}-${key}`,
        role,
        order: maxOrder + 1,
        title: '新提示词',
        promptTemplate: '',
      };
      const mergedRole = [...inRole, next].map((x, idx) => ({ ...x, order: idx + 1 }));
      const merged = base
        .filter((x) => x.role !== role)
        .concat(mergedRole)
        .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
      // 保持 UpdatedAt/id 不变（保存后由后端回填）
      if (prev) return { ...prev, prompts: merged };
      const created: PromptSettings = {
        id: 'global',
        updatedAt: new Date().toISOString(),
        prompts: merged,
      };
      return created;
    });
    // 等 state 更新后再切换 active
    setActivePromptKey((_) => `prompt-${roleKeyToSuffix(roleEnumToKey(roleEnum))}-${key}`);
  };

  const removePrompt = (promptKey: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const base = normalizePrompts(prev.prompts);
      const removed = base.find((x) => x.promptKey === promptKey) ?? null;
      const nextAll = base.filter((x) => x.promptKey !== promptKey);
      if (!removed) return { ...prev, prompts: nextAll };
      // 仅在该 role 内重排 order
      const role = removed.role;
      const roleList = nextAll.filter((x) => x.role === role).sort((a, b) => a.order - b.order).map((x, idx) => ({ ...x, order: idx + 1 }));
      const merged = nextAll.filter((x) => x.role !== role).concat(roleList).sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
      return { ...prev, prompts: merged };
    });
    setActivePromptKey((prev) => {
      if (prev !== promptKey) return prev;
      const rest = roleStages.filter((x) => x.promptKey !== promptKey).sort((a, b) => a.order - b.order);
      return rest[0]?.promptKey ?? '';
    });
  };

  const copyPromptKey = async (k: string) => {
    try {
      await navigator.clipboard.writeText(k);
      setMsg('已复制 promptKey');
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
      const url = joinUrl(getApiBaseUrl(), '/api/v1/admin/prompts/optimize/stream');
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          promptKey: stage?.promptKey ?? null,
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
    setPromptField('promptTemplate', next);
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
      const trimmedPrompts = [...prompts]
        .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)))
        .map((p) => ({
          promptKey: p.promptKey.trim(),
          role: p.role,
          order: Number(p.order),
          title: (p.title ?? '').trim(),
          promptTemplate: (p.promptTemplate ?? '').trim(),
        }));
      const res = await putAdminPrompts({ prompts: trimmedPrompts }, idem);
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '保存失败'}`);
        return;
      }
      // 先用 PUT 返回回填（UpdatedAt 由后端生成）
      const saved = res.data?.settings;
      if (!saved || !Array.isArray(saved.prompts)) {
        setErr('保存成功但响应缺少 settings，请刷新重试（可能是代理/后端返回异常）');
        return;
      }
      setSettings(saved);
      setBaselineSig(stableKey({ prompts: normalizePrompts(saved?.prompts) }));

      // 保存后以 PUT 返回为准（避免用额外 GET 覆盖本地编辑态）。
      setIsOverridden(true);
      setMsg('已保存');
      const k = Date.now();
      setSaveAnimKey(k);
      window.setTimeout(() => {
        setSaveAnimKey((prev) => (prev === k ? 0 : prev));
      }, 900);
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
      const res = await resetAdminPrompts(idem);
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
              按提示词（可增删/排序）与角色（PM/DEV/QA）配置标题与提示词模板；将影响 Desktop 提示词按钮与问答注入。
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
        <div
          className="rounded-[14px] px-4 py-3 text-sm relative overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(34,197,94,0.95)' }}
        >
          {msg}
          {msg === '已保存' && saveAnimKey ? (
            <span
              key={saveAnimKey}
              className="ps-save-rocket"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                top: '50%',
                pointerEvents: 'none',
                color: 'rgba(255, 215, 140, 0.95)',
                filter: 'drop-shadow(0 10px 18px rgba(0,0,0,0.35))',
                animation: 'psSaveRocketFly 820ms cubic-bezier(0.22, 0.9, 0.28, 1) both',
              }}
            >
              <Rocket size={16} />
            </span>
          ) : null}
        </div>
      )}

      <style>
        {`
@keyframes psSaveRocketFly {
  0% {
    transform: translate3d(-48px, -50%, 0) rotate(-10deg) scale(0.95);
    opacity: 0;
  }
  12% { opacity: 1; }
  88% { opacity: 1; }
  100% {
    transform: translate3d(calc(100% + 48px), -50%, 0) rotate(10deg) scale(1.05);
    opacity: 0;
  }
}
        `}
      </style>

      <div className="grid gap-4 min-h-0" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
        <Card className="p-4 min-h-0 flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>提示词总览</div>
            <div className="shrink-0">
              <Button variant="secondary" size="xs" onClick={addPrompt} disabled={loading || saving}>
                <Plus size={14} />
                新增
              </Button>
            </div>
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            共 {roleStages.length} 个提示词（{roleEnum}；支持新增/删除/排序/切换）
          </div>
          <div className="mt-3 flex-1 min-h-0 overflow-auto grid gap-2">
            {roleStages.map((s) => {
              const active = s.promptKey === (activePromptKey || roleStages[0]?.promptKey || '');
              return (
                <div
                  key={s.promptKey}
                  className="rounded-[14px] transition-colors"
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent-gold) 10%, var(--bg-input))' : 'var(--bg-input)',
                    border: active ? '1px solid color-mix(in srgb, var(--accent-gold) 42%, var(--border-default))' : '1px solid var(--border-subtle)',
                  }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setActivePromptKey(s.promptKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActivePromptKey(s.promptKey);
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const from = e.dataTransfer.getData('text/plain');
                      const to = s.promptKey;
                      if (!from || from === to) return;
                      setSettings((prev) => {
                        if (!prev) return prev;
                        const all = normalizePrompts(prev.prompts);
                        const list = all.filter((x) => x.role === roleEnum).sort((a, b) => a.order - b.order);
                        const fromIdx = list.findIndex((x) => x.promptKey === from);
                        const toIdx = list.findIndex((x) => x.promptKey === to);
                        if (fromIdx < 0 || toIdx < 0) return prev;
                        const moved = [...list];
                        const [item] = moved.splice(fromIdx, 1);
                        moved.splice(toIdx, 0, item);
                        const renumbered = moved.map((x, i) => ({ ...x, order: i + 1 }));
                        const merged = all
                          .filter((x) => x.role !== roleEnum)
                          .concat(renumbered)
                          .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role.localeCompare(b.role)));
                        return { ...prev, prompts: merged };
                      });
                    }}
                    className="w-full text-left px-3 py-3 outline-none"
                    title={normalizeText(s.title).trim() || `提示词 ${s.order}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          try {
                            e.dataTransfer.setData('text/plain', s.promptKey);
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
                        {normalizeText(s.title).trim() || `提示词 ${s.order}`}
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
              {stage?.promptKey && (
                <div className="mt-1 text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                  <span className="truncate">promptKey：{stage.promptKey}</span>
                  <button
                    type="button"
                    onClick={() => void copyPromptKey(stage.promptKey)}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                    style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.04)' }}
                    aria-label="复制 promptKey"
                    title="复制 promptKey"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )}
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                提示词模板用于“聚焦指令”：点击 Desktop 的提示词按钮会触发注入，输出应严格遵守结构与约束。
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <ConfirmTip
                title="删除提示词？"
                description="将删除当前提示词（不可恢复）。建议先保存导出或复制内容。"
                confirmText="确认删除"
                onConfirm={() => {
                  if (stage?.promptKey) removePrompt(stage.promptKey);
                }}
                disabled={loading || saving || !stage?.promptKey || roleStages.length <= 1}
                side="top"
                align="end"
              >
                <Button variant="danger" size="xs" disabled={loading || saving || !stage?.promptKey || roleStages.length <= 1}>
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
                <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>标题（title）</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>用于 Desktop 提示词按钮展示</div>
              </div>
              <input
                value={stage?.title ?? ''}
                onChange={(e) => setPromptField('title', e.target.value)}
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
                <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>提示词模板（promptTemplate）</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  字符：{(stage?.promptTemplate ?? '').length.toLocaleString()}
                </div>
              </div>
              <div className="mt-2 flex-1 min-h-[340px] relative">
                <textarea
                  value={stage?.promptTemplate ?? ''}
                  onChange={(e) => setPromptField('promptTemplate', e.target.value)}
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
              小建议：更推荐写“要关注什么、按什么结构输出、缺失要如何标注”。保存后约 5 分钟全端生效（后端有缓存）。
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
                当前：role={roleEnum} · order={stage?.order ?? '—'} · promptKey={stage?.promptKey ?? '—'}
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


