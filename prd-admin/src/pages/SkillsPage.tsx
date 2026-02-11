import { useCallback, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  listAdminSkills,
  createAdminSkill,
  updateAdminSkill,
  deleteAdminSkill,
  type AdminSkill,
  type AdminCreateSkillRequest,
  type SkillExecutionConfig,
  type SkillInputConfig,
  type SkillOutputConfig,
} from '@/services/real/skills';

// ━━━ 默认配置 ━━━━━━━━

const defaultInput: SkillInputConfig = {
  contextScope: 'prd',
  acceptsUserInput: false,
  acceptsAttachments: false,
  parameters: [],
};

const defaultExecution: SkillExecutionConfig = {
  promptTemplate: '',
  modelType: 'chat',
  toolChain: [],
};

const defaultOutput: SkillOutputConfig = {
  mode: 'chat',
  echoToChat: false,
};

const ROLE_OPTIONS = ['PM', 'DEV', 'QA'] as const;
const CONTEXT_OPTIONS = [
  { value: 'prd', label: 'PRD 文档' },
  { value: 'all', label: '全部消息' },
  { value: 'current', label: '当前对话' },
  { value: 'none', label: '无上下文' },
];
const OUTPUT_MODES = [
  { value: 'chat', label: '对话输出' },
  { value: 'download', label: '文件下载' },
  { value: 'clipboard', label: '复制到剪贴板' },
];
const VISIBILITY_OPTIONS = [
  { value: 'system', label: '系统' },
  { value: 'public', label: '公共' },
];

// ━━━ 主组件 ━━━━━━━━

export default function SkillsPage() {
  const { isMobile } = useBreakpoint();
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AdminSkill | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // ━━━ 表单状态 ━━━

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skillKey, setSkillKey] = useState('');
  const [icon, setIcon] = useState('');
  const [category, setCategory] = useState('general');
  const [tags, setTags] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [visibility, setVisibility] = useState('system');
  const [order, setOrder] = useState(1);
  const [isEnabled, setIsEnabled] = useState(true);
  const [isBuiltIn, setIsBuiltIn] = useState(false);
  const [contextScope, setContextScope] = useState('prd');
  const [acceptsUserInput, setAcceptsUserInput] = useState(false);
  const [acceptsAttachments, setAcceptsAttachments] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState('');
  const [systemPromptOverride, setSystemPromptOverride] = useState('');
  const [modelType, setModelType] = useState('chat');
  const [outputMode, setOutputMode] = useState('chat');
  const [echoToChat, setEchoToChat] = useState(false);

  // ━━━ 加载 ━━━

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    const res = await listAdminSkills();
    if (res.success && res.data) {
      setSkills(res.data.skills);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  // ━━━ 填充表单 ━━━

  const fillForm = useCallback((s: AdminSkill | null) => {
    if (!s) {
      setTitle(''); setDescription(''); setSkillKey(''); setIcon('');
      setCategory('general'); setTags(''); setRoles([]); setVisibility('system');
      setOrder(1); setIsEnabled(true); setIsBuiltIn(false);
      setContextScope('prd'); setAcceptsUserInput(false); setAcceptsAttachments(false);
      setPromptTemplate(''); setSystemPromptOverride(''); setModelType('chat');
      setOutputMode('chat'); setEchoToChat(false);
      return;
    }
    setTitle(s.title);
    setDescription(s.description);
    setSkillKey(s.skillKey);
    setIcon(s.icon ?? '');
    setCategory(s.category);
    setTags(s.tags.join(', '));
    setRoles(s.roles);
    setVisibility(s.visibility);
    setOrder(s.order);
    setIsEnabled(s.isEnabled);
    setIsBuiltIn(s.isBuiltIn);
    setContextScope(s.input?.contextScope ?? 'prd');
    setAcceptsUserInput(s.input?.acceptsUserInput ?? false);
    setAcceptsAttachments(s.input?.acceptsAttachments ?? false);
    setPromptTemplate(s.execution?.promptTemplate ?? '');
    setSystemPromptOverride(s.execution?.systemPromptOverride ?? '');
    setModelType(s.execution?.modelType ?? 'chat');
    setOutputMode(s.output?.mode ?? 'chat');
    setEchoToChat(s.output?.echoToChat ?? false);
  }, []);

  const handleSelect = useCallback((s: AdminSkill) => {
    setSelected(s); setIsCreating(false); fillForm(s); setMsg(null);
  }, [fillForm]);

  const handleNew = useCallback(() => {
    setSelected(null); setIsCreating(true); fillForm(null); setMsg(null);
  }, [fillForm]);

  // ━━━ 构建请求体 ━━━

  const buildRequest = useCallback((): AdminCreateSkillRequest => ({
    skillKey: skillKey || undefined,
    title,
    description,
    icon: icon || undefined,
    category,
    tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    roles,
    visibility,
    order,
    isEnabled,
    isBuiltIn,
    input: {
      ...defaultInput,
      contextScope,
      acceptsUserInput,
      acceptsAttachments,
    },
    execution: {
      ...defaultExecution,
      promptTemplate,
      systemPromptOverride: systemPromptOverride || undefined,
      modelType,
    },
    output: {
      ...defaultOutput,
      mode: outputMode,
      echoToChat,
    },
  }), [title, description, skillKey, icon, category, tags, roles, visibility, order,
       isEnabled, isBuiltIn, contextScope, acceptsUserInput, acceptsAttachments,
       promptTemplate, systemPromptOverride, modelType, outputMode, echoToChat]);

  // ━━━ 保存 ━━━

  const handleSave = useCallback(async () => {
    if (!title.trim()) { setMsg({ type: 'err', text: '名称不能为空' }); return; }
    setSaving(true);
    const req = buildRequest();
    const res = isCreating
      ? await createAdminSkill(req)
      : selected
        ? await updateAdminSkill(selected.skillKey, req)
        : null;

    if (res?.success) {
      setMsg({ type: 'ok', text: isCreating ? '创建成功' : '保存成功' });
      setIsCreating(false);
      await fetchSkills();
      // 选中新创建的
      if (isCreating && res.data && 'skillKey' in res.data) {
        const newKey = (res.data as { skillKey: string }).skillKey;
        const updated = await listAdminSkills();
        if (updated.success && updated.data) {
          setSkills(updated.data.skills);
          const found = updated.data.skills.find(s => s.skillKey === newKey);
          if (found) { setSelected(found); fillForm(found); }
        }
      }
    } else {
      setMsg({ type: 'err', text: res?.error?.message ?? '操作失败' });
    }
    setSaving(false);
  }, [title, buildRequest, isCreating, selected, fetchSkills, fillForm]);

  // ━━━ 删除 ━━━

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`确定删除技能「${selected.title}」？`)) return;
    const res = await deleteAdminSkill(selected.skillKey);
    if (res?.success) {
      setMsg({ type: 'ok', text: '已删除' });
      setSelected(null); fillForm(null);
      fetchSkills();
    } else {
      setMsg({ type: 'err', text: res?.error?.message ?? '删除失败' });
    }
  }, [selected, fetchSkills, fillForm]);

  // ━━━ 角色切换 ━━━

  const toggleRole = useCallback((r: string) => {
    setRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  }, []);

  // ━━━ 分组显示 ━━━

  const grouped = useMemo(() => {
    const system = skills.filter(s => s.visibility === 'system');
    const pub = skills.filter(s => s.visibility === 'public');
    return { system, public: pub };
  }, [skills]);

  // ━━━ 渲染 ━━━

  const showEditor = selected || isCreating;
  const mobileShowEditor = isMobile && showEditor;

  const handleMobileBack = useCallback(() => {
    setSelected(null);
    setIsCreating(false);
    setMsg(null);
  }, []);

  return (
    <div className={`flex gap-4 h-[calc(100vh-6rem)] ${isMobile ? 'flex-col' : ''}`}>
      {/* ━━━ 左侧列表 ━━━ */}
      {(!isMobile || !mobileShowEditor) && (
      <GlassCard className={`${isMobile ? 'w-full' : 'w-80'} shrink-0 flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-sm font-semibold opacity-80">技能列表</h2>
          <button
            onClick={handleNew}
            className="text-xs px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition"
          >
            + 新增
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {loading && <div className="text-center text-xs opacity-50 py-8">加载中...</div>}

          {!loading && grouped.system.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/30 px-2 mb-1">系统技能</div>
              {grouped.system.map(s => (
                <SkillListItem
                  key={s.skillKey} skill={s}
                  active={selected?.skillKey === s.skillKey}
                  onClick={() => handleSelect(s)}
                />
              ))}
            </div>
          )}

          {!loading && grouped.public.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/30 px-2 mb-1">公共技能</div>
              {grouped.public.map(s => (
                <SkillListItem
                  key={s.skillKey} skill={s}
                  active={selected?.skillKey === s.skillKey}
                  onClick={() => handleSelect(s)}
                />
              ))}
            </div>
          )}

          {!loading && skills.length === 0 && (
            <div className="text-center text-xs opacity-40 py-8">
              暂无技能，点击"+ 新增"创建
            </div>
          )}
        </div>
      </GlassCard>
      )}

      {/* ━━━ 右侧编辑器 ━━━ */}
      {(!isMobile || mobileShowEditor) && (
      <GlassCard className="flex-1 flex flex-col overflow-hidden">
        {!showEditor ? (
          <div className="flex-1 flex items-center justify-center text-sm opacity-30">
            选择左侧技能编辑，或点击"+ 新增"
          </div>
        ) : (
          <>
            {/* 顶栏 */}
            <div className="p-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {isMobile && (
                  <button
                    onClick={handleMobileBack}
                    className="text-xs px-2 py-1.5 rounded-lg bg-white/10 text-white/60 hover:bg-white/15 transition"
                  >
                    &larr; 返回
                  </button>
                )}
                <h2 className="text-sm font-semibold">
                  {isCreating ? '新增技能' : `编辑：${selected?.title ?? ''}`}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {msg && (
                  <span className={`text-xs ${msg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                    {msg.text}
                  </span>
                )}
                <button
                  onClick={handleSave} disabled={saving}
                  className="text-xs px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition disabled:opacity-40"
                >
                  {saving ? '保存中...' : '保存'}
                </button>
                {selected && !isCreating && (
                  <button
                    onClick={handleDelete}
                    className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 transition"
                  >
                    删除
                  </button>
                )}
              </div>
            </div>

            {/* 编辑表单 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              {/* 基本信息 */}
              <Section title="基本信息">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="名称 *">
                    <input value={title} onChange={e => setTitle(e.target.value)}
                      className="field-input" placeholder="技能名称" />
                  </Field>
                  <Field label="SkillKey">
                    <input value={skillKey} onChange={e => setSkillKey(e.target.value)}
                      className="field-input" placeholder="自动生成" disabled={!isCreating} />
                  </Field>
                  <Field label="图标">
                    <input value={icon} onChange={e => setIcon(e.target.value)}
                      className="field-input" placeholder="emoji" />
                  </Field>
                  <Field label="分类">
                    <input value={category} onChange={e => setCategory(e.target.value)}
                      className="field-input" placeholder="analysis" />
                  </Field>
                  <Field label="排序">
                    <input type="number" value={order} onChange={e => setOrder(Number(e.target.value))}
                      className="field-input" />
                  </Field>
                  <Field label="可见性">
                    <select value={visibility} onChange={e => setVisibility(e.target.value)} className="field-input">
                      {VISIBILITY_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="描述" className="mt-3">
                  <input value={description} onChange={e => setDescription(e.target.value)}
                    className="field-input" placeholder="技能描述" />
                </Field>
                <Field label="标签" className="mt-3">
                  <input value={tags} onChange={e => setTags(e.target.value)}
                    className="field-input" placeholder="逗号分隔，如: 分析, PRD" />
                </Field>

                {/* 角色 */}
                <div className="mt-3">
                  <label className="text-xs text-white/50 mb-1 block">适用角色（空 = 全部）</label>
                  <div className="flex flex-wrap gap-2">
                    {ROLE_OPTIONS.map(r => (
                      <button key={r} onClick={() => toggleRole(r)}
                        className={`text-xs px-3 py-1 rounded-full border transition ${
                          roles.includes(r)
                            ? 'border-amber-400/60 bg-amber-500/20 text-amber-300'
                            : 'border-white/10 bg-white/5 text-white/40 hover:border-white/20'
                        }`}
                      >{r}</button>
                    ))}
                  </div>
                </div>

                {/* 开关 */}
                <div className="mt-3 flex flex-wrap gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-white/60">
                    <input type="checkbox" checked={isEnabled} onChange={e => setIsEnabled(e.target.checked)} />
                    启用
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-white/60">
                    <input type="checkbox" checked={isBuiltIn} onChange={e => setIsBuiltIn(e.target.checked)} />
                    内置（不可被用户删除）
                  </label>
                </div>
              </Section>

              {/* 输入配置 */}
              <Section title="输入配置">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="上下文范围">
                    <select value={contextScope} onChange={e => setContextScope(e.target.value)} className="field-input">
                      {CONTEXT_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="flex flex-wrap items-end gap-4 pb-1">
                    <label className="flex items-center gap-1.5 text-xs text-white/60">
                      <input type="checkbox" checked={acceptsUserInput} onChange={e => setAcceptsUserInput(e.target.checked)} />
                      接受用户输入
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-white/60">
                      <input type="checkbox" checked={acceptsAttachments} onChange={e => setAcceptsAttachments(e.target.checked)} />
                      接受附件
                    </label>
                  </div>
                </div>
              </Section>

              {/* 执行配置 */}
              <Section title="执行配置">
                <Field label="提示词模板 (promptTemplate)">
                  <textarea value={promptTemplate} onChange={e => setPromptTemplate(e.target.value)}
                    className="field-input min-h-[120px] font-mono text-xs" placeholder="支持 {{变量}} 占位符" />
                </Field>
                <Field label="系统提示词覆盖 (可选)" className="mt-3">
                  <textarea value={systemPromptOverride} onChange={e => setSystemPromptOverride(e.target.value)}
                    className="field-input min-h-[80px] font-mono text-xs" placeholder="留空使用默认角色系统提示词" />
                </Field>
                <Field label="模型类型" className="mt-3">
                  <input value={modelType} onChange={e => setModelType(e.target.value)}
                    className="field-input" placeholder="chat" />
                </Field>
              </Section>

              {/* 输出配置 */}
              <Section title="输出配置">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="输出模式">
                    <select value={outputMode} onChange={e => setOutputMode(e.target.value)} className="field-input">
                      {OUTPUT_MODES.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-1.5 text-xs text-white/60">
                      <input type="checkbox" checked={echoToChat} onChange={e => setEchoToChat(e.target.checked)} />
                      同时回显到对话
                    </label>
                  </div>
                </div>
              </Section>
            </div>
          </>
        )}
      </GlassCard>
      )}

      <style>{`
        .field-input {
          width: 100%;
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.05);
          color: rgba(255,255,255,0.9);
          font-size: 13px;
          outline: none;
          transition: border-color 0.15s;
        }
        .field-input:focus {
          border-color: rgba(255,255,255,0.3);
        }
        .field-input:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        select.field-input {
          cursor: pointer;
        }
        select.field-input option {
          background: #1a1a2e;
          color: #fff;
        }
        textarea.field-input {
          resize: vertical;
        }
      `}</style>
    </div>
  );
}

// ━━━ 子组件 ━━━━━━━━

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2 border-b border-white/5 pb-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label className="text-xs text-white/50 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function SkillListItem({ skill, active, onClick }: { skill: AdminSkill; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition ${
        active
          ? 'bg-white/10 border border-white/20'
          : 'hover:bg-white/5 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-base">{skill.icon || '⚡'}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{skill.title}</div>
          <div className="text-[10px] text-white/30 mt-0.5">
            {skill.skillKey}
            {skill.roles.length > 0 && ` · ${skill.roles.join('/')}`}
            {!skill.isEnabled && ' · 已禁用'}
          </div>
        </div>
        <span className="text-[10px] text-white/20">#{skill.order}</span>
      </div>
    </button>
  );
}
