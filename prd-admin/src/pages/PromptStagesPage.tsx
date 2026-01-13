import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Dialog } from '@/components/ui/Dialog';
import { getAdminPrompts, getAdminSystemPrompts, putAdminPrompts, putAdminSystemPrompts, resetAdminPrompts, resetAdminSystemPrompts, listLiteraryPrompts, createLiteraryPrompt, updateLiteraryPrompt, deleteLiteraryPrompt } from '@/services';
import type { PromptEntry, PromptSettings } from '@/services/contracts/prompts';
import type { SystemPromptEntry, SystemPromptSettings } from '@/services/contracts/systemPrompts';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { RefreshCw, Save, RotateCcw, AlertTriangle, Plus, Trash2, Copy, Sparkles, Square, Rocket } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type RoleKey = 'pm' | 'dev' | 'qa';
type RoleEnum = 'PM' | 'DEV' | 'QA';

type TopTabKey = 'prd' | 'literary';
type PrdTabKey = 'user' | 'system';

function SegmentedTabs<T extends string>(props: {
  items: Array<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { items, value, onChange, disabled, ariaLabel } = props;
  return (
    <div
      className="inline-flex items-center max-w-full p-1 rounded-[14px] overflow-x-auto"
      style={{ 
        background: 'rgba(0,0,0,0.20)', 
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.3) inset',
      }}
      aria-label={ariaLabel}
    >
      {items.map((x) => {
        const active = x.key === value;
        return (
          <button
            key={x.key}
            type="button"
            className="h-[32px] px-4 rounded-[11px] text-[13px] font-semibold transition-all duration-200 inline-flex items-center gap-2 shrink-0 whitespace-nowrap"
            style={{
              color: active ? '#1a1206' : 'var(--text-secondary)',
              background: active ? 'var(--gold-gradient)' : 'transparent',
              boxShadow: active ? '0 2px 8px -2px rgba(214, 178, 106, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1) inset' : 'none',
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
              transform: active ? 'scale(1)' : 'scale(0.98)',
            }}
            disabled={!!disabled}
            aria-pressed={active}
            onClick={() => onChange(x.key)}
          >
            {x.label}
          </button>
        );
      })}
    </div>
  );
}

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

function roleEnumToChineseLabel(r: RoleEnum): string {
  if (r === 'DEV') return '开发工程师（DEV）';
  if (r === 'QA') return '质量工程师（QA）';
  return '产品经理（PM）';
}

function normalizeText(v: unknown): string {
  return typeof v === 'string' ? v : '';
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

function normalizeSystemEntries(entries: SystemPromptEntry[] | null | undefined): SystemPromptEntry[] {
  const src = Array.isArray(entries) ? entries : [];
  const out: SystemPromptEntry[] = [];

  for (let i = 0; i < src.length; i += 1) {
    const raw = (src[i] ?? {}) as Partial<SystemPromptEntry>;
    const role = (normalizeText((raw as { role?: unknown }).role).toUpperCase() as RoleEnum) || 'PM';
    if (role !== 'PM' && role !== 'DEV' && role !== 'QA') continue;
    out.push({
      role,
      systemPrompt: normalizeText((raw as { systemPrompt?: unknown }).systemPrompt),
    });
  }

  return out.sort((a, b) => a.role.localeCompare(b.role));
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
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saveAnimKey, setSaveAnimKey] = useState<number>(0);

  const [topTab, setTopTab] = useState<TopTabKey>('prd');
  const [prdTab, setPrdTab] = useState<PrdTabKey>('user');
  
  // 文学创作提示词状态
  const [literaryLoading, setLiteraryLoading] = useState(false);
  const [literaryPrompts, setLiteraryPrompts] = useState<Array<{
    id: string;
    title: string;
    content: string;
    scenarioType?: string | null;
    order: number;
    isSystem: boolean;
  }>>([]);
  const [literaryScenarioFilter, setLiteraryScenarioFilter] = useState<string | null>('article-illustration');
  const [literaryEditingId, setLiteraryEditingId] = useState<string | null>(null);
  const [literaryEditingTitle, setLiteraryEditingTitle] = useState('');
  const [literaryEditingContent, setLiteraryEditingContent] = useState('');
  const [literaryCreating, setLiteraryCreating] = useState(false);
  const [literaryNewTitle, setLiteraryNewTitle] = useState('');
  const [literaryNewContent, setLiteraryNewContent] = useState('');
  const [literaryError, setLiteraryError] = useState<string | null>(null);

  const [, setIsOverridden] = useState(false);
  const [settings, setSettings] = useState<PromptSettings | null>(null);
  const [baselineSig, setBaselineSig] = useState<string>('');

  const [sysLoading, setSysLoading] = useState(false);
  const [sysSaving, setSysSaving] = useState(false);
  const [sysErr, setSysErr] = useState<string | null>(null);
  const [sysMsg, setSysMsg] = useState<string | null>(null);
  const [, setSysIsOverridden] = useState(false);
  const [sysSettings, setSysSettings] = useState<SystemPromptSettings | null>(null);
  const [sysBaselineSig, setSysBaselineSig] = useState<string>('');

  const [activePromptKey, setActivePromptKey] = useState<string>('');
  const [activeRole, setActiveRole] = useState<RoleKey>('pm');

  // 提示词优化（魔法棒）
  const [optOpen, setOptOpen] = useState(false);
  const [optBusy, setOptBusy] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [optText, setOptText] = useState<string>('');
  const [optOriginal, setOptOriginal] = useState<string>('');
  const optAbortRef = useRef<AbortController | null>(null);

  // 系统提示词结构化编辑
  const [sysEditMode, setSysEditMode] = useState<'structured' | 'raw'>('structured');
  const [sysStructured, setSysStructured] = useState({
    roleDefinition: '',
    coreResponsibilities: '',
    focusAreas: '',
    responseStyle: '',
    outputFormat: '',
    boundaries: '',
    dataUsageInstructions: '',
    outputRequirements: '',
  });

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

  const loadSystem = useCallback(async () => {
    setSysLoading(true);
    setSysErr(null);
    setSysMsg(null);
    try {
      const res = await getAdminSystemPrompts();
      if (!res.success) {
        setSysErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setSysIsOverridden(!!res.data.isOverridden);
      setSysSettings(res.data.settings);
      setSysBaselineSig(stableKey({ entries: normalizeSystemEntries(res.data.settings?.entries) }));
    } finally {
      setSysLoading(false);
    }
  }, []);

  useEffect(() => {
    if (topTab !== 'prd' || prdTab !== 'system') return;
    if (sysSettings) return;
    void loadSystem();
  }, [topTab, prdTab, sysSettings, loadSystem]);

  // 加载文学创作提示词
  const loadLiterary = useCallback(async () => {
    setLiteraryLoading(true);
    setLiteraryError(null);
    try {
      const res = await listLiteraryPrompts({ scenarioType: literaryScenarioFilter });
      if (!res.success) {
        setLiteraryError(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setLiteraryPrompts(res.data?.items || []);
    } finally {
      setLiteraryLoading(false);
    }
  }, [literaryScenarioFilter]);

  useEffect(() => {
    if (topTab !== 'literary') return;
    void loadLiterary();
  }, [topTab, loadLiterary]);

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

  const roleLabel = useMemo(() => roleEnumToChineseLabel(roleEnum), [roleEnum]);

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

  const sysEntries = useMemo(() => normalizeSystemEntries(sysSettings?.entries), [sysSettings?.entries]);
  const sysText = useMemo(() => sysEntries.find((x) => x.role === roleEnum)?.systemPrompt ?? '', [sysEntries, roleEnum]);
  const sysCurrentSig = useMemo(() => stableKey({ entries: sysEntries }), [sysEntries]);
  const isSysDirty = useMemo(() => !!sysBaselineSig && sysBaselineSig !== sysCurrentSig, [sysBaselineSig, sysCurrentSig]);
  const sysValidation = useMemo(() => {
    const entries = sysEntries;
    const byRole = new Map<RoleEnum, string>();
    for (const e of entries) {
      const role = (normalizeText(e.role).toUpperCase() as RoleEnum) || 'PM';
      const text = normalizeText(e.systemPrompt).trim();
      byRole.set(role, text);
    }
    for (const role of ['PM', 'DEV', 'QA'] as const) {
      const v = byRole.get(role) ?? '';
      if (!v) return { ok: false, message: `systemPrompt 不能为空（${role}）` };
      const lower = v.toLowerCase();
      if (lower.includes('只返回json') || lower.includes('only return json') || lower.includes('json schema') || lower.includes('```json')) {
        return { ok: false, message: `禁止在系统提示词中配置 JSON 输出强制约束（${role}）` };
      }
      if (v.length > 20000) return { ok: false, message: `systemPrompt 过长（上限 20000 字符，${role}）` };
    }
    return { ok: true, message: '' };
  }, [sysEntries]);

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

  const setSystemPromptText = useCallback((value: string) => {
    setSysSettings((prev) => {
      if (!prev) return prev;
      const base = normalizeSystemEntries(prev.entries);
      const exists = base.some((x) => x.role === roleEnum);
      const nextEntries = (exists ? base : [...base, { role: roleEnum, systemPrompt: '' }]).map((x) =>
        x.role === roleEnum ? { ...x, systemPrompt: value } : x
      );
      return { ...prev, entries: nextEntries };
    });
  }, [roleEnum]);

  // 解析 systemPrompt 到结构化字段（启发式匹配）
  useEffect(() => {
    const raw = sysText.trim();
    if (!raw) {
      setSysStructured({
        roleDefinition: '',
        coreResponsibilities: '',
        focusAreas: '',
        responseStyle: '',
        outputFormat: '',
        boundaries: '',
        dataUsageInstructions: '',
        outputRequirements: '',
      });
      return;
    }

    // 简单启发式：按 # 标题拆分
    const lines = raw.split('\n');
    const sections: Record<string, string> = {};
    let currentKey = '';
    let currentLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        if (currentKey && currentLines.length > 0) {
          sections[currentKey] = currentLines.join('\n').trim();
        }
        currentKey = trimmed.substring(2).trim();
        currentLines = [];
      } else if (currentKey) {
        currentLines.push(line);
      }
    }
    if (currentKey && currentLines.length > 0) {
      sections[currentKey] = currentLines.join('\n').trim();
    }

    setSysStructured({
      roleDefinition: sections['角色定义'] || '',
      coreResponsibilities: sections['核心职责'] || '',
      focusAreas: sections['关注领域'] || '',
      responseStyle: sections['回答风格'] || '',
      outputFormat: sections['输出格式（必须 Markdown）'] || sections['输出格式'] || '',
      boundaries: sections['边界约束'] || '',
      dataUsageInstructions: sections['资料使用说明（重要）'] || sections['资料使用说明'] || '',
      outputRequirements: sections['输出要求（必须遵守）'] || sections['输出要求'] || '',
    });
  }, [sysText]);

  // 从结构化字段生成 Raw
  const generateRawFromStructured = useCallback(() => {
    const parts: string[] = [];
    if (sysStructured.roleDefinition.trim()) parts.push(`# 角色定义\n${sysStructured.roleDefinition.trim()}`);
    if (sysStructured.coreResponsibilities.trim()) parts.push(`# 核心职责\n${sysStructured.coreResponsibilities.trim()}`);
    if (sysStructured.focusAreas.trim()) parts.push(`# 关注领域\n${sysStructured.focusAreas.trim()}`);
    if (sysStructured.responseStyle.trim()) parts.push(`# 回答风格\n${sysStructured.responseStyle.trim()}`);
    if (sysStructured.outputFormat.trim()) parts.push(`# 输出格式（必须 Markdown）\n${sysStructured.outputFormat.trim()}`);
    if (sysStructured.boundaries.trim()) parts.push(`# 边界约束\n${sysStructured.boundaries.trim()}`);
    if (sysStructured.dataUsageInstructions.trim()) parts.push(`# 资料使用说明（重要）\n${sysStructured.dataUsageInstructions.trim()}`);
    if (sysStructured.outputRequirements.trim()) parts.push(`# 输出要求（必须遵守）\n${sysStructured.outputRequirements.trim()}`);
    const generated = parts.join('\n\n');
    setSystemPromptText(generated);
    setSysEditMode('raw');
  }, [sysStructured, setSystemPromptText]);

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

  const saveSystem = async () => {
    if (!sysSettings) return;
    if (!sysValidation.ok) {
      setSysErr(sysValidation.message);
      return;
    }
    setSysSaving(true);
    setSysErr(null);
    setSysMsg(null);
    try {
      const idem = safeIdempotencyKey();
      const trimmedEntries = normalizeSystemEntries(sysSettings.entries).map((e) => ({
        role: e.role,
        systemPrompt: (e.systemPrompt ?? '').trim(),
      }));
      const res = await putAdminSystemPrompts({ entries: trimmedEntries }, idem);
      if (!res.success) {
        setSysErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '保存失败'}`);
        return;
      }
      const saved = res.data?.settings;
      if (!saved || !Array.isArray(saved.entries)) {
        setSysErr('保存成功但响应缺少 settings，请刷新重试（可能是代理/后端返回异常）');
        return;
      }
      setSysSettings(saved);
      setSysBaselineSig(stableKey({ entries: normalizeSystemEntries(saved.entries) }));
      setSysIsOverridden(true);
      setSysMsg('已保存');
      const k = Date.now();
      setSaveAnimKey(k);
      window.setTimeout(() => {
        setSaveAnimKey((prev) => (prev === k ? 0 : prev));
      }, 900);
    } finally {
      setSysSaving(false);
    }
  };

  const resetSystem = async () => {
    setSysSaving(true);
    setSysErr(null);
    setSysMsg(null);
    try {
      const idem = safeIdempotencyKey();
      const res = await resetAdminSystemPrompts(idem);
      if (!res.success) {
        setSysErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '恢复默认失败'}`);
        return;
      }
      setSysMsg('已恢复为系统默认系统提示词');
      setSysSettings(null);
      setSysBaselineSig('');
      await loadSystem();
    } finally {
      setSysSaving(false);
    }
  };

  const showPrd = topTab === 'prd';
  const showLiterary = topTab === 'literary';
  const showUserPrompts = showPrd && prdTab === 'user';
  const showSystemPrompts = showPrd && prdTab === 'system';

  const uiLoading = showUserPrompts ? loading : showSystemPrompts ? sysLoading : false;
  const uiSaving = showUserPrompts ? saving : showSystemPrompts ? sysSaving : false;
  const uiErr = showUserPrompts ? err : showSystemPrompts ? sysErr : null;
  const uiMsg = showUserPrompts ? msg : showSystemPrompts ? sysMsg : null;
  const uiIsDirty = showUserPrompts ? isDirty : showSystemPrompts ? isSysDirty : false;
  const uiValidation = showUserPrompts ? validation : showSystemPrompts ? sysValidation : { ok: true, message: '' };

  // 顶部提示条：3s 自动消失
  useEffect(() => {
    if (!uiMsg) return;
    const t = window.setTimeout(() => {
      if (showUserPrompts) setMsg(null);
      else if (showSystemPrompts) setSysMsg(null);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [uiMsg, showUserPrompts, showSystemPrompts]);

  const goTest = useCallback(
    (args: { role: RoleEnum; promptKey?: string | null }) => {
      // 获取当前提示词的完整数据
      const prompt = showUserPrompts && args.promptKey
        ? prompts.find((p) => p.promptKey === args.promptKey)
        : null;
      
      // 通过 state 传递临时数据
      navigate('/ai-chat', {
        state: {
          testMode: true,
          role: args.role,
          promptKey: args.promptKey || '',
          promptTitle: prompt?.title || '',
          promptTemplate: prompt?.promptTemplate || '',
        },
      });
    },
    [navigate, showUserPrompts, prompts]
  );

  const onChangePrdTab = useCallback((next: PrdTabKey) => {
    setPrdTab(next);
    // 清理对方 tab 的提示，避免切换后还残留
    if (next === 'user') {
      setSysErr(null);
      setSysMsg(null);
    } else {
      setErr(null);
      setMsg(null);
    }
  }, []);

  return (
    <div className="h-full min-h-0 flex flex-col gap-6 overflow-x-hidden">
      <PageHeader
        title="提示词管理"
        variant="gold"
        tabsInline={true}
        tabs={[
          { key: 'prd', label: 'PRD提示词' },
          { key: 'literary', label: '文学创作' },
        ]}
        activeTab={topTab}
        onTabChange={(next) => {
          setTopTab(next as TopTabKey);
          setErr(null);
          setMsg(null);
          setSysErr(null);
          setSysMsg(null);
        }}
        actions={
          <div className="flex items-center gap-2">
            {(showUserPrompts || showSystemPrompts) && !uiValidation.ok && (
              <span className="text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>
                {uiValidation.message}
              </span>
            )}
            {uiIsDirty && (
              <Badge variant="featured" size="sm" icon={<AlertTriangle size={10} />}>
                未保存
              </Badge>
            )}
          </div>
        }
      />

      {uiErr && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(255,120,120,0.95)' }}>
          {uiErr}
        </div>
      )}
      {uiMsg && (
        <div
          className="rounded-[14px] px-4 py-3 text-sm relative overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(34,197,94,0.95)' }}
        >
          {uiMsg}
          {uiMsg === '已保存' && saveAnimKey ? (
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

      {showUserPrompts && (
        <div className="grid gap-6 flex-1 min-h-0 overflow-x-hidden" style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}>
        <Card className="p-5 h-full min-h-0 flex flex-col min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="text-sm font-semibold shrink-0" style={{ color: 'var(--text-primary)' }}>快捷指令</div>
            <div className="shrink-0">
              <SegmentedTabs<PrdTabKey>
                ariaLabel="PRD 提示词类型切换"
                items={[
                  { key: 'user', label: '用户提示词' },
                  { key: 'system', label: '系统提示词' },
                ]}
                value={prdTab}
                onChange={onChangePrdTab}
                disabled={loading || saving}
              />
            </div>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 min-w-0">
            <div className="text-[11px] min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>
              共 {roleStages.length} 个提示词（{roleEnum}；支持新增/删除/排序/切换）
            </div>
            <Button variant="secondary" size="xs" onClick={addPrompt} disabled={loading || saving} className="shrink-0">
              <Plus size={14} />
              新增
            </Button>
          </div>
          <div className="mt-3 flex-1 min-h-0 overflow-auto overflow-x-hidden grid gap-2 min-w-0 content-start items-start auto-rows-min">
            {roleStages.map((s) => {
              const active = s.promptKey === (activePromptKey || roleStages[0]?.promptKey || '');
              return (
                <div
                  key={s.promptKey}
                  className="rounded-[16px] transition-all duration-200 min-w-0 overflow-hidden relative cursor-pointer hover:scale-[1.01]"
                  style={{
                    background: active 
                      ? 'linear-gradient(135deg, color-mix(in srgb, var(--accent-gold) 12%, var(--bg-input)) 0%, color-mix(in srgb, var(--accent-gold) 8%, var(--bg-input)) 100%)'
                      : 'var(--bg-input)',
                    border: active 
                      ? '1px solid color-mix(in srgb, var(--accent-gold) 40%, transparent)' 
                      : '1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent)',
                    boxShadow: active 
                      ? '0 4px 16px -4px rgba(214, 178, 106, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.03) inset'
                      : '0 2px 8px -2px rgba(0, 0, 0, 0.2)',
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
                    <div className="flex items-start justify-between gap-3 min-w-0">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
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

                      <button
                        type="button"
                        className="h-[28px] px-2.5 rounded-[10px] text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5 shrink-0"
                        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          goTest({ role: roleEnum, promptKey: s.promptKey });
                        }}
                        title="跳转到 AI 对话页测试该提示词（上传 PRD 后一键运行）"
                      >
                        测试
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-4 min-h-0 flex flex-col min-w-0 overflow-hidden" variant="default">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  编辑器：order {stage?.order ?? 0} · {roleLabel}
                </div>
                <SegmentedTabs<RoleKey>
                  items={[
                    { key: 'pm', label: 'PM' },
                    { key: 'dev', label: 'DEV' },
                    { key: 'qa', label: 'QA' },
                  ]}
                  value={activeRole}
                  onChange={(next) => setActiveRole(next)}
                  disabled={loading || saving}
                  ariaLabel="切换角色（PM/DEV/QA）"
                />
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                提示词模板用于"聚焦指令"：点击 Desktop 的提示词按钮会触发注入，输出应严格遵守结构与约束。
              </div>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (showUserPrompts) {
                      goTest({ role: roleEnum, promptKey: activePromptKey || null });
                      return;
                    }
                    goTest({ role: roleEnum, promptKey: null });
                  }}
                  disabled={uiLoading || uiSaving}
                  title="跳转到 AI 对话页进行测试（上传 PRD / 选择角色与提示词 / 一键运行）"
                >
                  测试
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={showUserPrompts ? load : loadSystem}
                  disabled={uiLoading || uiSaving}
                >
                  <RefreshCw size={16} />
                  刷新
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={showUserPrompts ? save : saveSystem}
                  disabled={
                    uiLoading ||
                    uiSaving ||
                    (showUserPrompts ? !settings : !sysSettings) ||
                    !uiIsDirty ||
                    !uiValidation.ok
                  }
                  title={!uiIsDirty ? '未修改无需保存' : !uiValidation.ok ? '请先修正校验错误' : '保存'}
                >
                  <Save size={16} />
                  保存
                </Button>
                <ConfirmTip
                  title="恢复默认？"
                  description={
                    showUserPrompts
                      ? '将删除管理员覆盖配置，所有阶段提示词回落到系统默认（不可恢复覆盖内容）。'
                      : '将删除管理员覆盖配置，系统提示词回落到系统默认（不可恢复覆盖内容）。'
                  }
                  confirmText="确认恢复默认"
                  onConfirm={showUserPrompts ? reset : resetSystem}
                  disabled={uiLoading || uiSaving}
                  side="top"
                  align="end"
                >
                  <Button variant="danger" size="sm" disabled={uiLoading || uiSaving}>
                    <RotateCcw size={16} />
                    恢复默认
                  </Button>
                </ConfirmTip>
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
            </div>
          </div>

          <div className="mt-4 flex-1 min-h-0 flex flex-col gap-3">
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
              <div className="mt-2 flex-1 min-h-0 relative">
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
      )}

      {showSystemPrompts && (
        <div
          className="grid gap-6 flex-1 min-h-0 overflow-x-hidden"
          style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}
        >
          <Card className="p-5 h-full min-h-0 flex flex-col min-w-0 overflow-hidden">
            <div className="flex items-center justify-between gap-3 min-w-0">
              <div className="text-sm font-semibold shrink-0" style={{ color: 'var(--text-primary)' }}>系统指令</div>
              <div className="shrink-0">
                <SegmentedTabs<PrdTabKey>
                  ariaLabel="PRD 提示词类型切换"
                  items={[
                    { key: 'user', label: '用户提示词' },
                    { key: 'system', label: '系统提示词' },
                  ]}
                  value={prdTab}
                  onChange={onChangePrdTab}
                  disabled={sysLoading || sysSaving}
                />
              </div>
            </div>
            <div className="mt-1 text-[11px] min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>
              按角色（PM/DEV/QA）分别配置 PRD 问答 system prompt；仅用于"输出结构/边界/资料使用说明"等非 JSON 约束。
            </div>
            {/* 角色按钮行按需求删除：改为直接点击下方卡片选中 */}

            <div className="mt-3 flex-1 min-h-0 overflow-auto overflow-x-hidden grid gap-2 min-w-0 content-start items-start auto-rows-min">
              {(['PM', 'DEV', 'QA'] as const).map((r) => {
                const active = r === roleEnum;
                const label = roleEnumToChineseLabel(r);
                return (
                  <div
                    key={r}
                    className="rounded-[16px] px-4 py-3.5 transition-all duration-200 min-w-0 overflow-hidden cursor-pointer hover:scale-[1.01]"
                    style={{
                      background: active 
                        ? 'linear-gradient(135deg, color-mix(in srgb, var(--accent-gold) 12%, var(--bg-input)) 0%, color-mix(in srgb, var(--accent-gold) 8%, var(--bg-input)) 100%)'
                        : 'var(--bg-input)',
                      border: active 
                        ? '1px solid color-mix(in srgb, var(--accent-gold) 40%, transparent)' 
                        : '1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent)',
                      boxShadow: active 
                        ? '0 4px 16px -4px rgba(214, 178, 106, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.03) inset'
                        : '0 2px 8px -2px rgba(0, 0, 0, 0.2)',
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      const rk = roleEnumToKey(r);
                      setActiveRole(rk);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        const rk = roleEnumToKey(r);
                        setActiveRole(rk);
                      }
                    }}
                  >
                    <div className="flex items-center justify-between gap-3 min-w-0">
                      <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>{label}</div>
                      <button
                        type="button"
                        className="h-[28px] px-2.5 rounded-[10px] text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5 shrink-0"
                        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          goTest({ role: r, promptKey: null });
                        }}
                        title="跳转到 AI 对话页测试该角色（上传 PRD 后一键运行）"
                      >
                        测试
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-4 min-h-0 flex flex-col min-w-0 overflow-hidden" variant="default">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    编辑器：{roleLabel} · systemPrompt
                  </div>
                  <SegmentedTabs<'structured' | 'raw'>
                    items={[
                      { key: 'structured', label: '结构化' },
                      { key: 'raw', label: 'Raw' },
                    ]}
                    value={sysEditMode}
                    onChange={(next) => setSysEditMode(next)}
                    disabled={sysLoading || sysSaving}
                    ariaLabel="切换编辑模式"
                  />
                  {sysEditMode === 'structured' && (
                    <Button variant="primary" size="xs" onClick={generateRawFromStructured} disabled={sysLoading || sysSaving}>
                      应用到 Raw
                    </Button>
                  )}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  注意：这里禁止写入"只返回 JSON / JSON schema / ```json"等约束（避免用户误配导致 PRD 问答异常）。
                </div>
              </div>
              <div className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                字符：{(sysText ?? '').length.toLocaleString()}
              </div>
            </div>

            {sysEditMode === 'structured' ? (
              <div className="mt-3 flex-1 min-h-0 grid grid-cols-2 gap-3" style={{ gridAutoRows: '1fr' }}>
                {[
                  { key: 'roleDefinition', label: '角色定义', placeholder: '例如：你是一位资深产品经理...' },
                  { key: 'coreResponsibilities', label: '核心职责', placeholder: '例如：从业务价值和用户体验角度解读需求...' },
                  { key: 'focusAreas', label: '关注领域', placeholder: '例如：1. 业务背景与问题定义\n2. 核心用户与使用场景...' },
                  { key: 'responseStyle', label: '回答风格', placeholder: '例如：简洁、清晰、结构化...' },
                  { key: 'outputFormat', label: '输出格式（必须 Markdown）', placeholder: '例如：使用 Markdown 小节、列表...' },
                  { key: 'boundaries', label: '边界约束', placeholder: '例如：不回答与 PRD 无关的问题...' },
                  { key: 'dataUsageInstructions', label: '资料使用说明（重要）', placeholder: '例如：优先引用 PRD 原文...' },
                  { key: 'outputRequirements', label: '输出要求（必须遵守）', placeholder: '例如：必须使用 Markdown 格式...' },
                ].map((field) => (
                  <div key={field.key} className="flex flex-col min-h-0">
                    <div className="text-xs font-semibold mb-1.5 shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {field.label}
                    </div>
                    <textarea
                      value={sysStructured[field.key as keyof typeof sysStructured]}
                      onChange={(e) => setSysStructured((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      disabled={sysLoading || sysSaving || !sysSettings}
                      className="flex-1 min-h-0 w-full rounded-[14px] px-3 py-2.5 text-[13px] outline-none resize-none transition-all duration-200 focus:ring-2 focus:ring-offset-0"
                      style={{
                        border: '1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent)',
                        background: 'linear-gradient(135deg, var(--bg-input) 0%, color-mix(in srgb, var(--bg-input) 98%, black) 100%)',
                        color: 'var(--text-primary)',
                        lineHeight: 1.6,
                        boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.2) inset, 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent-gold) 40%, transparent)';
                        e.currentTarget.style.boxShadow = '0 2px 8px -2px rgba(0, 0, 0, 0.2) inset, 0 0 0 1px rgba(214, 178, 106, 0.2) inset, 0 0 0 2px rgba(214, 178, 106, 0.1)';
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--border-subtle) 60%, transparent)';
                        e.currentTarget.style.boxShadow = '0 2px 8px -2px rgba(0, 0, 0, 0.2) inset, 0 0 0 1px rgba(255, 255, 255, 0.02) inset';
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex-1 min-h-0">
                <textarea
                  value={sysText ?? ''}
                  onChange={(e) => setSystemPromptText(e.target.value)}
                  placeholder="建议包含：资料使用说明、输出结构（Markdown 小节）、PRD 未覆盖时的处理方式、边界约束等（禁止 JSON 输出强制约束）"
                  disabled={sysLoading || sysSaving || !sysSettings}
                  className="h-full w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
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
            )}

            <div className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              生效范围：仅 PRD 问答（会话问答 / 本章提问）。不影响 gaps/分析等需要 JSON 输出的内部任务。
            </div>
          </Card>
        </div>
      )}

      {/* 文学创作提示词管理 */}
      {showLiterary && (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          {literaryError && (
            <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(255,120,120,0.95)' }}>
              {literaryError}
            </div>
          )}

          <Card className="p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>文学创作提示词</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  管理文学创作场景的提示词模板（支持场景分类与全局共享）
                </div>
              </div>
              <div className="flex items-center gap-2">
                <SegmentedTabs<string>
                  ariaLabel="场景筛选"
                  items={[
                    { key: 'article-illustration', label: '文章配图' },
                    { key: 'global', label: '全局共享' },
                  ]}
                  value={literaryScenarioFilter || 'article-illustration'}
                  onChange={(next) => {
                    setLiteraryScenarioFilter(next === 'global' ? null : next);
                  }}
                  disabled={literaryLoading}
                />
                <Button variant="secondary" size="sm" onClick={() => void loadLiterary()} disabled={literaryLoading}>
                  <RefreshCw size={16} />
                  刷新
                </Button>
                <Button variant="primary" size="sm" onClick={() => setLiteraryCreating(true)} disabled={literaryLoading}>
                  <Plus size={16} />
                  新建
                </Button>
              </div>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
              {literaryPrompts.map((prompt) => (
                <Card key={prompt.id} className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {prompt.title}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        {(!prompt.scenarioType || prompt.scenarioType === 'global') ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(168, 85, 247, 0.12)', color: 'rgba(168, 85, 247, 0.95)', border: '1px solid rgba(168, 85, 247, 0.28)' }}>
                            全局
                          </span>
                        ) : prompt.scenarioType === 'article-illustration' ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(34, 197, 94, 0.12)', color: 'rgba(34, 197, 94, 0.95)', border: '1px solid rgba(34, 197, 94, 0.28)' }}>
                            文章配图
                          </span>
                        ) : null}
                        {prompt.isSystem && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(147, 197, 253, 0.12)', color: 'rgba(147, 197, 253, 0.95)', border: '1px solid rgba(147, 197, 253, 0.28)' }}>
                            系统
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs mt-2 line-clamp-3" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {prompt.content}
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <Button variant="secondary" size="xs" onClick={() => { setLiteraryEditingId(prompt.id); setLiteraryEditingTitle(prompt.title); setLiteraryEditingContent(prompt.content); }} disabled={literaryLoading}>
                      编辑
                    </Button>
                    {!prompt.isSystem && (
                      <Button variant="danger" size="xs" onClick={async () => { if (!confirm(`确定要删除「${prompt.title}」吗？`)) return; const res = await deleteLiteraryPrompt({ id: prompt.id }); if (res.success) { await loadLiterary(); } else { setLiteraryError(res.error?.message || '删除失败'); } }} disabled={literaryLoading}>
                        <Trash2 size={12} />
                        删除
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>

            {literaryPrompts.length === 0 && !literaryLoading && (
              <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
                暂无提示词，点击「新建」创建第一个模板
              </div>
            )}
          </Card>
        </div>
      )}

      {/* 新建文学创作提示词对话框 */}
      <Dialog open={literaryCreating} onOpenChange={(open) => !open && setLiteraryCreating(false)} title="新建文学创作提示词" description="创建一个新的提示词模板" maxWidth={800} content={
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>标题</label>
              <input type="text" value={literaryNewTitle} onChange={(e) => setLiteraryNewTitle(e.target.value)} placeholder="例如：文章配图标准模板" className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field" />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>内容</label>
              <textarea value={literaryNewContent} onChange={(e) => setLiteraryNewContent(e.target.value)} placeholder="输入提示词内容..." rows={12} className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none resize-none font-mono prd-field" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setLiteraryCreating(false)}>取消</Button>
              <Button variant="primary" onClick={async () => { if (!literaryNewTitle.trim() || !literaryNewContent.trim()) { setLiteraryError('标题和内容不能为空'); return; } const res = await createLiteraryPrompt({ title: literaryNewTitle, content: literaryNewContent, scenarioType: literaryScenarioFilter || 'article-illustration' }); if (res.success) { setLiteraryCreating(false); setLiteraryNewTitle(''); setLiteraryNewContent(''); await loadLiterary(); } else { setLiteraryError(res.error?.message || '创建失败'); } }} disabled={!literaryNewTitle.trim() || !literaryNewContent.trim()}>
                创建
              </Button>
            </div>
          </div>
        }
      />

      {/* 编辑文学创作提示词对话框 */}
      <Dialog open={!!literaryEditingId} onOpenChange={(open) => !open && setLiteraryEditingId(null)} title="编辑文学创作提示词" description="修改提示词模板" maxWidth={800} content={
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>标题</label>
              <input type="text" value={literaryEditingTitle} onChange={(e) => setLiteraryEditingTitle(e.target.value)} className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field" />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>内容</label>
              <textarea value={literaryEditingContent} onChange={(e) => setLiteraryEditingContent(e.target.value)} rows={12} className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none resize-none font-mono prd-field" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setLiteraryEditingId(null)}>取消</Button>
              <Button variant="primary" onClick={async () => { if (!literaryEditingId || !literaryEditingTitle.trim() || !literaryEditingContent.trim()) { setLiteraryError('标题和内容不能为空'); return; } const res = await updateLiteraryPrompt({ id: literaryEditingId, title: literaryEditingTitle, content: literaryEditingContent }); if (res.success) { setLiteraryEditingId(null); await loadLiterary(); } else { setLiteraryError(res.error?.message || '保存失败'); } }} disabled={!literaryEditingTitle.trim() || !literaryEditingContent.trim()}>
                保存
              </Button>
            </div>
          </div>
        }
      />

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


