import { useCallback, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { getAdminSystemPrompts, putAdminSystemPrompts, resetAdminSystemPrompts } from '@/services';
import type { SystemPromptEntry, SystemPromptSettings } from '@/services/contracts/systemPrompts';
import { RefreshCw, Save, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBreakpoint } from '@/hooks/useBreakpoint';

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

function roleEnumToChineseLabel(r: RoleEnum): string {
  if (r === 'DEV') return '开发工程师（DEV）';
  if (r === 'QA') return '质量工程师（QA）';
  return '产品经理（PM）';
}

function normalizeText(v: unknown): string {
  return typeof v === 'string' ? v : '';
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

function normalizeSystemEntries(entries: SystemPromptEntry[] | null | undefined): SystemPromptEntry[] {
  const src = Array.isArray(entries) ? entries : [];
  const out: SystemPromptEntry[] = [];
  for (const raw of src) {
    const role = (normalizeText((raw as { role?: unknown }).role).toUpperCase() as RoleEnum) || 'PM';
    if (role !== 'PM' && role !== 'DEV' && role !== 'QA') continue;
    out.push({ role, systemPrompt: normalizeText((raw as { systemPrompt?: unknown }).systemPrompt) });
  }
  return out.sort((a, b) => a.role.localeCompare(b.role));
}

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function SystemPromptsPanel() {
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [settings, setSettings] = useState<SystemPromptSettings | null>(null);
  const [baselineSig, setBaselineSig] = useState('');
  const [activeRole, setActiveRole] = useState<RoleKey>('pm');
  const [editMode, setEditMode] = useState<'structured' | 'raw'>('structured');
  const [structured, setStructured] = useState({
    roleDefinition: '',
    coreResponsibilities: '',
    focusAreas: '',
    responseStyle: '',
    outputFormat: '',
    boundaries: '',
    dataUsageInstructions: '',
    outputRequirements: '',
  });

  const roleEnum = useMemo(() => roleKeyToEnum(activeRole), [activeRole]);
  const entries = useMemo(() => normalizeSystemEntries(settings?.entries), [settings?.entries]);
  const sysText = useMemo(() => entries.find((x) => x.role === roleEnum)?.systemPrompt ?? '', [entries, roleEnum]);
  const currentSig = useMemo(() => stableKey({ entries }), [entries]);
  const isDirty = useMemo(() => !!baselineSig && baselineSig !== currentSig, [baselineSig, currentSig]);

  const validation = useMemo(() => {
    const byRole = new Map<RoleEnum, string>();
    for (const e of entries) {
      const role = (normalizeText(e.role).toUpperCase() as RoleEnum) || 'PM';
      byRole.set(role, normalizeText(e.systemPrompt).trim());
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
  }, [entries]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await getAdminSystemPrompts();
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setSettings(res.data.settings);
      setBaselineSig(stableKey({ entries: normalizeSystemEntries(res.data.settings?.entries) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setSystemPromptText = useCallback((value: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const base = normalizeSystemEntries(prev.entries);
      const exists = base.some((x) => x.role === roleEnum);
      const nextEntries = (exists ? base : [...base, { role: roleEnum, systemPrompt: '' }]).map((x) =>
        x.role === roleEnum ? { ...x, systemPrompt: value } : x
      );
      return { ...prev, entries: nextEntries };
    });
  }, [roleEnum]);

  // Parse system prompt to structured fields
  useEffect(() => {
    const raw = sysText.trim();
    if (!raw) {
      setStructured({ roleDefinition: '', coreResponsibilities: '', focusAreas: '', responseStyle: '', outputFormat: '', boundaries: '', dataUsageInstructions: '', outputRequirements: '' });
      return;
    }
    const lines = raw.split('\n');
    const sections: Record<string, string> = {};
    let currentKey = '';
    let currentLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        if (currentKey && currentLines.length > 0) sections[currentKey] = currentLines.join('\n').trim();
        currentKey = trimmed.substring(2).trim();
        currentLines = [];
      } else if (currentKey) {
        currentLines.push(line);
      }
    }
    if (currentKey && currentLines.length > 0) sections[currentKey] = currentLines.join('\n').trim();
    setStructured({
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

  const generateRawFromStructured = useCallback(() => {
    const parts: string[] = [];
    if (structured.roleDefinition.trim()) parts.push(`# 角色定义\n${structured.roleDefinition.trim()}`);
    if (structured.coreResponsibilities.trim()) parts.push(`# 核心职责\n${structured.coreResponsibilities.trim()}`);
    if (structured.focusAreas.trim()) parts.push(`# 关注领域\n${structured.focusAreas.trim()}`);
    if (structured.responseStyle.trim()) parts.push(`# 回答风格\n${structured.responseStyle.trim()}`);
    if (structured.outputFormat.trim()) parts.push(`# 输出格式（必须 Markdown）\n${structured.outputFormat.trim()}`);
    if (structured.boundaries.trim()) parts.push(`# 边界约束\n${structured.boundaries.trim()}`);
    if (structured.dataUsageInstructions.trim()) parts.push(`# 资料使用说明（重要）\n${structured.dataUsageInstructions.trim()}`);
    if (structured.outputRequirements.trim()) parts.push(`# 输出要求（必须遵守）\n${structured.outputRequirements.trim()}`);
    setSystemPromptText(parts.join('\n\n'));
    setEditMode('raw');
  }, [structured, setSystemPromptText]);

  const save = async () => {
    if (!settings) return;
    if (!validation.ok) { setErr(validation.message); return; }
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const idem = safeIdempotencyKey();
      const trimmedEntries = normalizeSystemEntries(settings.entries).map((e) => ({
        role: e.role,
        systemPrompt: (e.systemPrompt ?? '').trim(),
      }));
      const res = await putAdminSystemPrompts({ entries: trimmedEntries }, idem);
      if (!res.success) { setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '保存失败'}`); return; }
      const saved = res.data?.settings;
      if (!saved || !Array.isArray(saved.entries)) { setErr('保存成功但响应缺少 settings，请刷新重试'); return; }
      setSettings(saved);
      setBaselineSig(stableKey({ entries: normalizeSystemEntries(saved.entries) }));
      setMsg('已保存');
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
      const res = await resetAdminSystemPrompts(idem);
      if (!res.success) { setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '恢复默认失败'}`); return; }
      setMsg('已恢复为系统默认系统提示词');
      setSettings(null);
      setBaselineSig('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const goTest = useCallback((role: RoleEnum) => {
    navigate('/prd-agent', { state: { testMode: true, role, promptKey: '' } });
  }, [navigate]);

  // Auto-dismiss messages
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 3000);
    return () => window.clearTimeout(t);
  }, [msg]);

  const roleLabel = roleEnumToChineseLabel(roleEnum);

  const STRUCTURED_FIELDS = [
    { key: 'roleDefinition', label: '角色定义', placeholder: '例如：你是一位资深产品经理...' },
    { key: 'coreResponsibilities', label: '核心职责', placeholder: '例如：从业务价值和用户体验角度解读需求...' },
    { key: 'focusAreas', label: '关注领域', placeholder: '例如：1. 业务背景与问题定义\n2. 核心用户与使用场景...' },
    { key: 'responseStyle', label: '回答风格', placeholder: '例如：简洁、清晰、结构化...' },
    { key: 'outputFormat', label: '输出格式（必须 Markdown）', placeholder: '例如：使用 Markdown 小节、列表...' },
    { key: 'boundaries', label: '边界约束', placeholder: '例如：不回答与 PRD 无关的问题...' },
    { key: 'dataUsageInstructions', label: '资料使用说明（重要）', placeholder: '例如：优先引用 PRD 原文...' },
    { key: 'outputRequirements', label: '输出要求（必须遵守）', placeholder: '例如：必须使用 Markdown 格式...' },
  ] as const;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {err && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid var(--border-default)', background: 'var(--nested-block-bg)', color: 'rgba(255,120,120,0.95)' }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid var(--border-default)', background: 'var(--nested-block-bg)', color: 'rgba(34,197,94,0.95)' }}>
          {msg}
        </div>
      )}

      <div className="grid gap-4 flex-1 min-h-0" style={{ gridTemplateColumns: isMobile ? '1fr' : '280px minmax(0, 1fr)' }}>
        {/* Left: Role cards */}
        <GlassCard animated className="p-4 h-full min-h-0 flex flex-col overflow-hidden" padding="none">
          <div className="p-4 pb-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>系统指令</div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              按角色（PM/DEV/QA）分别配置 PRD 问答 system prompt
            </div>
          </div>
          <div className="mt-3 flex-1 min-h-0 overflow-auto p-4 pt-0 space-y-2">
            {(['PM', 'DEV', 'QA'] as const).map((r) => {
              const active = r === roleEnum;
              const label = roleEnumToChineseLabel(r);
              return (
                <div
                  key={r}
                  className="rounded-[16px] px-4 py-3.5 transition-all duration-200 cursor-pointer hover:scale-[1.01]"
                  style={{
                    background: active
                      ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.12) 0%, rgba(99, 102, 241, 0.08) 100%)'
                      : 'var(--bg-input)',
                    border: active
                      ? '1px solid rgba(99, 102, 241, 0.40)'
                      : '1px solid var(--border-subtle)',
                    boxShadow: active
                      ? '0 4px 16px -4px rgba(99, 102, 241, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.03) inset'
                      : '0 2px 8px -2px rgba(0, 0, 0, 0.2)',
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveRole(roleEnumToKey(r))}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveRole(roleEnumToKey(r)); } }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</div>
                    <button
                      type="button"
                      className="h-[28px] px-2.5 rounded-[10px] text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5 shrink-0"
                      style={{ background: 'var(--bg-input-hover)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                      onClick={(e) => { e.stopPropagation(); goTest(r); }}
                      title="跳转到 AI 对话页测试"
                    >
                      测试
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </GlassCard>

        {/* Right: Editor */}
        <GlassCard animated className="p-4 min-h-0 flex flex-col overflow-hidden" padding="none">
          <div className="p-4 pb-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-3">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    编辑器：{roleLabel} · systemPrompt
                  </div>
                  <SegmentedTabs<'structured' | 'raw'>
                    items={[
                      { key: 'structured', label: '结构化' },
                      { key: 'raw', label: 'Raw' },
                    ]}
                    value={editMode}
                    onChange={setEditMode}
                    disabled={loading || saving}
                    ariaLabel="切换编辑模式"
                  />
                  {editMode === 'structured' && (
                    <Button variant="primary" size="xs" onClick={generateRawFromStructured} disabled={loading || saving}>
                      应用到 Raw
                    </Button>
                  )}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  禁止写入"只返回 JSON / JSON schema / ```json"等约束
                </div>
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <Button variant="secondary" size="sm" onClick={load} disabled={loading || saving}>
                    <RefreshCw size={16} /> 刷新
                  </Button>
                  <Button variant="primary" size="sm" onClick={save} disabled={loading || saving || !settings || !isDirty || !validation.ok}
                    title={!isDirty ? '未修改无需保存' : !validation.ok ? '请先修正校验错误' : '保存'}
                  >
                    <Save size={16} /> 保存
                  </Button>
                  <ConfirmTip
                    title="恢复默认？"
                    description="将删除管理员覆盖配置，系统提示词回落到系统默认（不可恢复覆盖内容）。"
                    confirmText="确认恢复默认"
                    onConfirm={reset}
                    disabled={loading || saving}
                    side="top"
                    align="end"
                  >
                    <Button variant="danger" size="sm" disabled={loading || saving}>
                      <RotateCcw size={16} /> 恢复默认
                    </Button>
                  </ConfirmTip>
                </div>
              </div>
              <div className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                字符：{sysText.length.toLocaleString()}
              </div>
            </div>
            {!validation.ok && (
              <div className="mt-2 text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>{validation.message}</div>
            )}
            {isDirty && (
              <div className="mt-2 text-xs px-2 py-1 rounded-lg inline-block" style={{ background: 'rgba(245, 158, 11, 0.12)', color: 'rgba(245, 158, 11, 0.95)', border: '1px solid rgba(245, 158, 11, 0.28)' }}>
                未保存
              </div>
            )}
          </div>

          {editMode === 'structured' ? (
            <div className="mt-3 flex-1 min-h-0 overflow-auto p-4 pt-0 grid grid-cols-2 gap-3" style={{ gridAutoRows: '1fr' }}>
              {STRUCTURED_FIELDS.map((field) => (
                <div key={field.key} className="flex flex-col min-h-0">
                  <div className="text-xs font-semibold mb-1.5 shrink-0" style={{ color: 'var(--text-muted)' }}>{field.label}</div>
                  <textarea
                    value={structured[field.key]}
                    onChange={(e) => setStructured((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    disabled={loading || saving || !settings}
                    className="flex-1 min-h-0 w-full rounded-[14px] px-3 py-2.5 text-[13px] outline-none resize-none"
                    style={{
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                      lineHeight: 1.6,
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex-1 min-h-0 p-4 pt-0">
              <textarea
                value={sysText}
                onChange={(e) => setSystemPromptText(e.target.value)}
                placeholder="建议包含：资料使用说明、输出结构（Markdown 小节）、PRD 未覆盖时的处理方式、边界约束等"
                disabled={loading || saving || !settings}
                className="h-full w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
                style={{
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--nested-block-bg)',
                  color: 'var(--text-primary)',
                  lineHeight: 1.6,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
              />
            </div>
          )}

          <div className="px-4 pb-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            生效范围：仅 PRD 问答（会话问答 / 本章提问）。不影响 gaps/分析等需要 JSON 输出的内部任务。
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
