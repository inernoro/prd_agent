import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  ClipboardCopy,
  Code2,
  Download,
  FlaskConical,
  Layers3,
  PackageCheck,
  Sparkles,
  UserRound,
  WandSparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  AGENT_EXPERIENCE_PROFILES,
  AGENT_ROLE_PROFILES,
  buildAgentStarterHarness,
  buildAgentStarterPrompt,
  type AgentExperienceId,
  type AgentRoleId,
} from '../lib/agent-starter'

interface AgentStarterTabProps {
  cdsPrompt: string
}

interface StarterSkill {
  key: string
  name: string
  description: string
  roles: AgentRoleId[]
  recommendedRoles: AgentRoleId[]
  groupKey: string
  groupLabel: string
}

const STEPS = ['经验', '角色', '技能', '交付', '开始'] as const

const FALLBACK_SKILLS: StarterSkill[] = [
  { key: 'skill-validation', name: '需求澄清', description: '发现模糊、遗漏和不可验收的需求。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], groupKey: 'foundation', groupLabel: '基础方法' },
  { key: 'plan-first', name: '先出方案', description: '动手前先说明路径、影响和取舍。', roles: ['pm', 'owner', 'domain-expert', 'dev'], recommendedRoles: ['pm', 'owner', 'domain-expert', 'dev'], groupKey: 'foundation', groupLabel: '基础方法' },
  { key: 'risk-matrix', name: '风险矩阵', description: '提前识别业务、体验和上线风险。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'domain-expert', 'qa'], groupKey: 'foundation', groupLabel: '基础方法' },
  { key: 'phase0-guard', name: '开工前置检查', description: '确认现状、边界和验证目标后再开始修改。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'domain-expert'], groupKey: 'foundation', groupLabel: '基础方法' },
  { key: 'preview-url', name: '真实预览地址', description: '部署后读取 CDS 返回的真实访问地址。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], groupKey: 'foundation', groupLabel: '基础方法' },
  { key: 'doc-writer', name: '仓库自适应文档', description: '先识别现有文档约定，再生成适合业务、产品和工程协作的文档。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'domain-expert'], groupKey: 'product', groupLabel: '产品与需求' },
  { key: 'product-document-generator', name: '产品文档生成', description: '生成结构化产品文档。', roles: ['pm', 'owner', 'domain-expert', 'dev'], recommendedRoles: ['pm', 'owner', 'domain-expert'], groupKey: 'product', groupLabel: '产品与需求' },
  { key: 'flow-trace', name: '业务流程追踪', description: '同时用业务语言和技术路径讲清完整流程。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['domain-expert'], groupKey: 'product', groupLabel: '产品与需求' },
  { key: 'conflict-resolution', name: '安全冲突处理', description: '动态识别默认分支，分级解决冲突并保留可恢复锚点。', roles: ['dev', 'qa'], recommendedRoles: ['dev'], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'scope-check', name: '分支边界审计', description: '结合仓库规则和所有权证据识别越界、共享与未知变更。', roles: ['owner', 'dev', 'qa'], recommendedRoles: ['dev', 'qa'], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'task-handoff-checklist', name: '任务交接清单', description: '把改动、验收证据、发布风险和用户操作路径完整交给下一位负责人。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'dev', 'qa'], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'human-verify', name: '对抗式人工验收', description: '从反向、边界和真实用户场景挑战结果。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['dev', 'qa'], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'code-hygiene', name: '代码卫生审计', description: '识别死代码、兼容垫片和隐性技术债。', roles: ['dev', 'qa'], recommendedRoles: ['dev'], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'create-skill-file', name: '创建新技能', description: '把团队方法沉淀成可复用技能。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: [], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'find-skills', name: '查找更多技能', description: '从本地和已连接的市场发现能力。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: [], groupKey: 'delivery', groupLabel: '研发交付' },
  { key: 'acceptance-test-design', name: '验收测试设计', description: '把需求转成正向、负向和边界场景。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['qa'], groupKey: 'quality', groupLabel: '测试验收' },
  { key: 'acceptance-checklist', name: '验收清单', description: '把结果变成可以逐项确认的步骤。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['pm', 'owner', 'domain-expert', 'qa'], groupKey: 'quality', groupLabel: '测试验收' },
  { key: 'acceptance-scenario-orchestrator', name: '复杂验收编排', description: '组织多阶段目标和证据。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: ['qa'], groupKey: 'quality', groupLabel: '测试验收' },
  { key: 'create-visual-test-to-kb', name: '视觉验收归档', description: '用浏览器取证并归档验收报告。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'], recommendedRoles: [], groupKey: 'quality', groupLabel: '测试验收' },
]

const roleIcons: Record<AgentRoleId, typeof BriefcaseBusiness> = {
  pm: BriefcaseBusiness,
  owner: Layers3,
  'domain-expert': UserRound,
  dev: Code2,
  qa: FlaskConical,
}

function normalizeSkills(payload: unknown): StarterSkill[] {
  const value = payload as any
  const bundles = value?.data?.bundles ?? value?.bundles ?? value?.data ?? value
  if (!Array.isArray(bundles)) return []

  const results: StarterSkill[] = []
  for (const bundle of bundles) {
    const skills = Array.isArray(bundle?.skills) ? bundle.skills : []
    const bundleRoles = Array.isArray(bundle?.roles) ? bundle.roles : []
    const groupKey = typeof bundle?.key === 'string' ? bundle.key : 'other'
    const groupLabel = typeof bundle?.label === 'string' ? bundle.label : '更多技能'
    for (const skill of skills) {
      const key = typeof skill === 'string' ? skill : skill?.key ?? skill?.id
      if (!key || results.some((item) => item.key === key)) continue
      results.push({
        key,
        name: typeof skill === 'string' ? skill : skill?.name ?? skill?.label ?? key,
        description: typeof skill === 'string' ? '为当前角色补充一项可执行能力。' : skill?.description ?? '为当前角色补充一项可执行能力。',
        roles: (Array.isArray(skill?.roles) ? skill.roles : bundleRoles) as AgentRoleId[],
        recommendedRoles: (Array.isArray(skill?.recommendedFor) ? skill.recommendedFor : skill?.roles ?? bundleRoles) as AgentRoleId[],
        groupKey,
        groupLabel,
      })
    }
  }
  return results
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function AgentStarterTab({ cdsPrompt }: AgentStarterTabProps) {
  const reduceMotion = useReducedMotion()
  const [step, setStep] = useState(0)
  const [experienceId, setExperienceId] = useState<AgentExperienceId>('newcomer')
  const [roleId, setRoleId] = useState<AgentRoleId>('pm')
  const [skills, setSkills] = useState<StarterSkill[]>(FALLBACK_SKILLS)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [showSkillLibrary, setShowSkillLibrary] = useState(false)
  const [activeSkillGroup, setActiveSkillGroup] = useState('foundation')
  const [includeCds, setIncludeCds] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/skills/bundles')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('skills unavailable')))
      .then((payload) => {
        const remoteSkills = normalizeSkills(payload)
        if (active && remoteSkills.length > 0) setSkills(remoteSkills)
      })
      .catch(() => {
        if (active) setSkills(FALLBACK_SKILLS)
      })
    return () => { active = false }
  }, [])

  const recommendedSkills = useMemo(() => {
    const matched = skills.filter((skill) => skill.recommendedRoles.includes(roleId))
    return (matched.length > 0 ? matched : FALLBACK_SKILLS.filter((skill) => skill.recommendedRoles.includes(roleId))).slice(0, 6)
  }, [roleId, skills])

  const availableSkills = useMemo(
    () => skills.filter((skill) => skill.roles.length === 0 || skill.roles.includes(roleId)),
    [roleId, skills],
  )
  const skillGroups = useMemo(() => {
    const groups = new Map<string, string>()
    for (const skill of availableSkills) groups.set(skill.groupKey, skill.groupLabel)
    return [...groups].map(([key, label]) => ({ key, label }))
  }, [availableSkills])
  const activeGroupSkills = availableSkills.filter((skill) => skill.groupKey === activeSkillGroup)

  useEffect(() => {
    setSelectedSkills(recommendedSkills.map((skill) => skill.key))
  }, [recommendedSkills])

  const selectedSkillItems = skills.filter((skill) => selectedSkills.includes(skill.key))
  const serviceOrigin = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
    ? 'https://cds.miduo.org'
    : window.location.origin

  const prompt = buildAgentStarterPrompt({
    experienceId,
    roleId,
    selectedSkillKeys: selectedSkillItems.map((skill) => skill.key),
    includeCds,
    cdsPrompt,
  })

  const harness = buildAgentStarterHarness({
    experienceId,
    roleId,
    selectedSkillKeys: selectedSkillItems.map((skill) => skill.key),
    includeCds,
    cdsOrigin: serviceOrigin,
  })

  const advance = (nextStep: number) => {
    setCopied(false)
    setStep(nextStep)
  }

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
  }

  return (
    <div data-agent-starter="true" className="flex h-[560px] max-h-[calc(100vh-190px)] min-h-[480px] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-[#fffdf9] text-stone-950 shadow-[0_20px_70px_rgba(75,54,38,0.08)]">
      <div className="border-b border-stone-200 bg-white px-7 py-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-warn">
              <Sparkles className="h-4 w-4" /> Agent Starter
            </div>
            <h3 className="mt-1 text-xl font-semibold tracking-tight">一句话改项目，一个地址看效果</h3>
          </div>
          <div className="hidden items-center gap-1 sm:flex">
            {STEPS.map((label, index) => (
              <div key={label} className="flex items-center gap-1">
                <div className={`h-2.5 rounded-full transition-all duration-300 ${index === step ? 'w-9 bg-warn' : index < step ? 'w-2.5 bg-stone-800' : 'w-2.5 bg-stone-200'}`} />
                {index === step && <span className="ml-1 text-xs font-semibold text-stone-700">{label}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden px-7 py-6">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.section
            key={step}
            initial={reduceMotion ? false : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: -18 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            className="flex h-full flex-col"
          >
            {step === 0 && (
              <>
                <StepHeading number="01" title="你希望 Agent 怎么跟你说话？" description="只影响解释方式，不限制能力。选一个最接近你的状态。" />
                <div className="mt-6 grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
                  {AGENT_EXPERIENCE_PROFILES.map((profile) => (
                    <ChoiceCard
                      key={profile.id}
                      selected={experienceId === profile.id}
                      title={profile.label}
                      eyebrow={profile.id === 'newcomer' ? 'AI 开发经验 1 年以内' : 'AI 开发经验 1 年以上'}
                      description={profile.description}
                      onClick={() => { setExperienceId(profile.id); advance(1) }}
                    />
                  ))}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <StepHeading number="02" title="你主要负责什么？" description="选择最接近的角色，系统会替你配置表达方式与技能起点。" />
                <div className="mt-5 grid flex-1 grid-cols-2 gap-3 lg:grid-cols-3">
                  {AGENT_ROLE_PROFILES.map((profile) => {
                    const Icon = roleIcons[profile.id]
                    return (
                      <ChoiceCard
                        key={profile.id}
                        selected={roleId === profile.id}
                        title={profile.label}
                        description={profile.description}
                        icon={<Icon className="h-5 w-5" />}
                        compact
                        onClick={() => { setRoleId(profile.id); advance(2) }}
                      />
                    )
                  })}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <StepHeading
                  number="03"
                  title={showSkillLibrary ? '再加一些工作方法' : '带上哪些工作方法？'}
                  description={showSkillLibrary ? '每次只看一类，选完返回推荐页，不需要一次读完所有技能。' : '已经按你的角色选好。可以取消，也可以按类别增加更多技能。'}
                />
                {showSkillLibrary && (
                  <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="技能分类">
                    {skillGroups.map((group) => (
                      <button
                        key={group.key}
                        type="button"
                        role="tab"
                        aria-selected={activeSkillGroup === group.key}
                        onClick={() => setActiveSkillGroup(group.key)}
                        className={`rounded-full px-4 py-2 text-xs font-bold transition-colors ${activeSkillGroup === group.key ? 'bg-stone-950 text-white' : 'border border-stone-300 bg-white text-stone-700 hover:border-stone-500'}`}
                      >
                        {group.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-4 grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto pr-1 lg:grid-cols-3">
                  {(showSkillLibrary ? activeGroupSkills : recommendedSkills).map((skill) => {
                    const selected = selectedSkills.includes(skill.key)
                    return (
                      <button
                        key={skill.key}
                        type="button"
                        onClick={() => setSelectedSkills((current) => selected ? current.filter((key) => key !== skill.key) : [...current, skill.key])}
                        className={`group relative rounded-xl border p-4 text-left transition-all ${selected ? 'border-warn bg-warn-soft text-stone-950 shadow-[0_8px_24px_rgba(194,91,33,0.12)]' : 'border-stone-300 bg-white text-stone-800 hover:border-stone-500'}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <PackageCheck className={`h-5 w-5 ${selected ? 'text-warn' : 'text-stone-500'}`} />
                          <span className={`grid h-5 w-5 place-items-center rounded-full border ${selected ? 'border-warn bg-warn text-white' : 'border-stone-400 bg-white'}`}>
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </span>
                        </div>
                        <div className="mt-3 text-sm font-bold">{skill.name}</div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-600">{skill.description}</p>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-4">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-stone-700">已选择 {selectedSkills.length} 项</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!showSkillLibrary && !skillGroups.some((group) => group.key === activeSkillGroup)) {
                          setActiveSkillGroup(skillGroups[0]?.key ?? 'foundation')
                        }
                        setShowSkillLibrary((value) => !value)
                      }}
                      className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-800 hover:border-stone-500"
                    >
                      {showSkillLibrary ? '返回角色推荐' : `选择更多技能（共 ${availableSkills.length} 项）`}
                    </button>
                  </div>
                  {!showSkillLibrary && <PrimaryNext onClick={() => advance(3)}>确认这些技能</PrimaryNext>}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <StepHeading number="04" title="改完以后，怎么交给你？" description="推荐让 CDS 自动部署。你说完需求，就能拿到可以直接打开的地址。" />
                <div className="mt-7 flex flex-1 items-center justify-center">
                  <button
                    type="button"
                    aria-pressed={includeCds}
                    onClick={() => setIncludeCds((value) => !value)}
                    className={`w-full max-w-2xl rounded-2xl border-2 p-7 text-left transition-all ${includeCds ? 'border-warn bg-warn-soft shadow-[0_18px_50px_rgba(194,91,33,0.15)]' : 'border-stone-300 bg-white'}`}
                  >
                    <div className="flex items-start gap-5">
                      <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${includeCds ? 'bg-warn text-white' : 'bg-stone-200 text-stone-600'}`}>
                        <WandSparkles className="h-6 w-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-4">
                          <h4 className="text-lg font-bold">接入 CDS，自动给预览地址</h4>
                          <span className={`rounded-full px-3 py-1 text-xs font-bold ${includeCds ? 'bg-warn text-white' : 'bg-stone-200 text-stone-700'}`}>{includeCds ? '已开启' : '未开启'}</span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-stone-700">自动处理项目扫描、分支部署、真实预览地址和登录验收。需要账号时，Agent 会验证后再交付安全的临时账号。</p>
                      </div>
                    </div>
                  </button>
                </div>
                <div className="mt-4 flex justify-end border-t border-stone-200 pt-4">
                  <PrimaryNext onClick={() => advance(4)}>生成我的上手包</PrimaryNext>
                </div>
              </>
            )}

            {step === 4 && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <motion.div initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="grid h-14 w-14 place-items-center rounded-2xl bg-stone-950 text-white shadow-xl">
                  <Check className="h-7 w-7" />
                </motion.div>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="mb-3 inline-flex min-h-11 items-center gap-2 self-start rounded-xl px-3 text-sm font-semibold text-stone-700 hover:bg-stone-100 hover:text-stone-950"
                >
                  <ArrowLeft className="h-4 w-4" />
                  返回修改
                </button>
                <h4 className="mt-5 text-2xl font-bold tracking-tight">你的 Agent 上手包已经配好</h4>
                <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">{selectedSkills.length} 项工作方法{includeCds ? '，另含 CDS 接入与真实预览能力' : ''}。复制后直接发给项目里的 Agent。</p>

                <motion.button
                  type="button"
                  onClick={copyPrompt}
                  animate={reduceMotion || copied ? undefined : {
                    scale: [1, 1.025, 1],
                    boxShadow: ['0 16px 45px rgba(194,91,33,0.22)', '0 22px 60px rgba(194,91,33,0.38)', '0 16px 45px rgba(194,91,33,0.22)'],
                  }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                  className={`mt-7 flex min-w-[300px] items-center justify-center gap-3 rounded-2xl px-8 py-4 text-base font-bold text-white transition-colors ${copied ? 'bg-ok' : 'agent-starter-copy bg-warn hover:bg-warn'}`}
                >
                  {copied ? <Check className="h-5 w-5" /> : <ClipboardCopy className="h-5 w-5" />}
                  {copied ? '已复制，现在交给 Agent' : '复制启动提示词'}
                  {!copied && <ArrowRight className="h-5 w-5" />}
                </motion.button>

                <div className="mt-5 flex items-center gap-3">
                  <button type="button" onClick={() => downloadText('cds-agent-starter.sh', harness)} className="inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-stone-800 hover:border-stone-500">
                    <Download className="h-4 w-4" /> 下载一键脚本
                  </button>
                  <a href={`${serviceOrigin}/api/skills/bundles`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2.5 text-sm font-semibold text-stone-700 hover:text-stone-950">
                    查看技能来源 <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
              </div>
            )}
          </motion.section>
        </AnimatePresence>
      </div>

      {step > 0 && step < 4 && (
        <div className="absolute bottom-5 left-8">
          <button type="button" onClick={() => advance(step - 1)} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-stone-100 hover:text-stone-950">
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
        </div>
      )}
    </div>
  )
}

function StepHeading({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="flex items-start gap-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warn-soft text-sm font-black text-warn">{number}</span>
      <div>
        <h4 className="text-xl font-bold tracking-tight text-stone-950">{title}</h4>
        <p className="mt-1 text-sm leading-6 text-stone-600">{description}</p>
      </div>
    </div>
  )
}

function ChoiceCard({ selected, title, eyebrow, description, icon, compact = false, onClick }: {
  selected: boolean
  title: string
  eyebrow?: string
  description: string
  icon?: React.ReactNode
  compact?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex min-h-0 flex-col justify-between rounded-2xl border-2 text-left transition-all duration-200 ${compact ? 'p-4' : 'p-6'} ${selected ? 'border-warn bg-warn-soft shadow-[0_14px_40px_rgba(194,91,33,0.13)]' : 'border-stone-300 bg-white hover:-translate-y-0.5 hover:border-stone-600 hover:shadow-lg'}`}
    >
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className={`grid h-9 w-9 place-items-center rounded-xl ${selected ? 'bg-warn text-white' : 'bg-stone-100 text-stone-700'}`}>{icon ?? <UserRound className="h-5 w-5" />}</div>
          <span className={`grid h-6 w-6 place-items-center rounded-full border ${selected ? 'border-warn bg-warn text-white' : 'border-stone-400 bg-white'}`}>{selected && <Check className="h-4 w-4" />}</span>
        </div>
        <h5 className={`${compact ? 'mt-3 text-base' : 'mt-5 text-xl'} font-bold text-stone-950`}>{title}</h5>
        {eyebrow && <div className="mt-1 text-xs font-bold uppercase tracking-wide text-warn">{eyebrow}</div>}
        <p className={`${compact ? 'mt-2 text-xs leading-5' : 'mt-3 text-sm leading-6'} text-stone-650 text-stone-700`}>{description}</p>
      </div>
      <div className="mt-3 flex items-center gap-1 text-xs font-bold text-stone-800 opacity-0 transition-opacity group-hover:opacity-100">选择并继续 <ArrowRight className="h-3.5 w-3.5" /></div>
    </button>
  )
}

function PrimaryNext({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-2 rounded-xl bg-stone-950 px-5 py-3 text-sm font-bold text-white shadow-lg transition-transform hover:-translate-y-0.5 hover:bg-black">
      {children} <ArrowRight className="h-4 w-4" />
    </button>
  )
}

export default AgentStarterTab
