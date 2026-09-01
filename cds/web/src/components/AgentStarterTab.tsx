import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Braces,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Code2,
  Download,
  FileText,
  FlaskConical,
  Layers3,
  PackageCheck,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_EXPERIENCE_PROFILES,
  AGENT_ROLE_PROFILES,
  buildAgentStarterHarness,
  buildAgentStarterPrompt,
  buildRoleCardHarness,
  buildRoleDecisionCardModel,
  type AgentDecisionCardModel,
  type AgentExperienceId,
  type AgentRoleId,
} from '../lib/agent-starter'
import { useAgentRoleSelection } from '../hooks/useAgentRoleSelection'
import { apiRequest } from '../lib/api'

interface AgentStarterTabProps {
  cdsPrompt: string
  /** 目标项目 id；为空表示还没选定既有项目，此时不上报角色。 */
  projectId?: string
  /** 切到同一个弹窗的技能市场 tab。缺省时来源面板不显示那个入口，不给死链。 */
  onOpenMarketplace?: () => void
}

/**
 * 服务端 `/api/skills/bundles` 的来源自述，字段与
 * `cds/src/services/skill-proxy.ts` 的 `StarterBundleSource` 对齐。
 * 这里不重复定义业务含义，只声明前端要渲染的形状。
 */
export interface SkillSourceInfo {
  kind: string
  bundleCount: number
  skillCount: number
  localSkillCount: number
  upstreamSkillCount: number
  upstreamConfigured: boolean
}

/** loading 还在读；ok 读到了真实清单；fallback 读不到，页面在用内置兜底清单。 */
export type SkillSourceState = 'loading' | 'ok' | 'fallback'

/** 技能库里代表「不分类，全都列出来」的伪分组 key。 */
export const ALL_SKILL_GROUP = '__all__'

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

/**
 * 读出清单的来源自述。
 *
 * 缺字段就返回 null，让面板说「这台 CDS 没报出来源」——**不要**用 0 兜底：
 * 「本机自带 0 个技能」和「不知道有几个」是两件完全不同的事，
 * 后者被显示成前者就是在编（见 no-rootless-tree）。
 */
export function normalizeSkillSource(payload: unknown): SkillSourceInfo | null {
  const value = payload as any
  const raw = value?.data?.source ?? value?.source
  if (!raw || typeof raw !== 'object') return null
  const num = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null
  const bundleCount = num(raw.bundleCount)
  const skillCount = num(raw.skillCount)
  const localSkillCount = num(raw.localSkillCount)
  const upstreamSkillCount = num(raw.upstreamSkillCount)
  if (bundleCount === null || skillCount === null || localSkillCount === null || upstreamSkillCount === null) {
    return null
  }
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
    bundleCount,
    skillCount,
    localSkillCount,
    upstreamSkillCount,
    upstreamConfigured: raw.upstreamConfigured === true,
  }
}

export interface SkillSelectionSummary {
  total: number
  /** 其中有几项是打开技能库之前就选好的（角色推荐 + 用户先前的取舍）。 */
  kept: number
  /** 这次在技能库里新加的。用来给卡片打「刚加上」，让改动看得见。 */
  added: number
  /** 这次在技能库里去掉的。数字变小时得说清是被减了，不能只报总数。 */
  removed: number
}

/**
 * 汇总「打开技能库前后」的差异。抽成纯函数是为了它能被单测直接钉住：
 * 底栏那行字是用户判断「我刚才干了什么」的唯一依据，不能只在渲染里算。
 */
export function summarizeSkillSelection(input: {
  selected: readonly string[]
  openedWith: readonly string[]
}): SkillSelectionSummary {
  const before = new Set(input.openedWith)
  const now = new Set(input.selected)
  let kept = 0
  let added = 0
  for (const key of now) {
    if (before.has(key)) kept += 1
    else added += 1
  }
  let removed = 0
  for (const key of before) if (!now.has(key)) removed += 1
  return { total: now.size, kept, added, removed }
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

export function AgentStarterTab({ cdsPrompt, projectId, onOpenMarketplace }: AgentStarterTabProps) {
  const reduceMotion = useReducedMotion()
  const [step, setStep] = useState(0)
  // 角色和经验档走共享 store：任务地图、项目卡都读同一个值，
  // 不再是这个组件私有的一次性选择。
  const [roleSelection, setRoleSelection] = useAgentRoleSelection()
  const { experienceId, roleId } = roleSelection
  // 只选经验时保持 declared 原样：此时 roleId 还是默认值，用户并没有选过角色。
  // 若在这里顺手置真，第一步选完经验就关掉向导的人，会在任务清单上看到
  // 按「产品经理」排序并标注的推荐——一个他从没做过的声明。
  const setExperienceId = (next: AgentExperienceId): void =>
    setRoleSelection({ ...roleSelection, experienceId: next })
  const setRoleId = (next: AgentRoleId): void =>
    setRoleSelection({ ...roleSelection, roleId: next, declared: true })
  const [skills, setSkills] = useState<StarterSkill[]>(FALLBACK_SKILLS)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  // 技能库是覆盖在推荐页之上的一层浮层，不是把推荐页换掉。
  // openedWith 记下打开那一刻的选择：「放弃这次改动」据它还原，
  // 「刚加上」标签据它计算——没有它，用户在库里点完就再也说不清自己改了什么。
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryOpenedWith, setLibraryOpenedWith] = useState<string[]>([])
  const [librarySearch, setLibrarySearch] = useState('')
  const [activeSkillGroup, setActiveSkillGroup] = useState(ALL_SKILL_GROUP)
  const [includeCds, setIncludeCds] = useState(true)
  const [copied, setCopied] = useState(false)
  const [showDecisionCard, setShowDecisionCard] = useState(false)
  const [showSkillSource, setShowSkillSource] = useState(false)
  const [skillSource, setSkillSource] = useState<SkillSourceInfo | null>(null)
  const [skillSourceState, setSkillSourceState] = useState<SkillSourceState>('loading')
  const [profileSync, setProfileSync] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  // 记下这条状态是给哪个项目写的：完成屏上还能换项目，换掉之后
  //「已记到项目」就不再成立，不能让它继续挂在新项目名下。
  const [syncedProjectId, setSyncedProjectId] = useState<string | undefined>(undefined)
  // 写入序号：只有最后一次写入的回调有权改 profileSync（防旧响应后到覆盖新结果）。
  const profileSyncTicket = useRef(0)
  const [prdAgentOrigin, setPrdAgentOrigin] = useState(
    () => String(import.meta.env.VITE_PRD_AGENT_BASE_URL || '').trim(),
  )

  // 读清单的结果要留痕：读到了什么、有没有读到，「技能来源」面板拿它回答用户。
  // 原来读失败是静默换成兜底清单的——用户看到的是一份缩水的技能库，
  // 却没有任何地方告诉他这不是完整的那份。
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadSkillBundles = useCallback(async () => {
    setSkillSourceState('loading')
    try {
      const response = await fetch('/api/skills/bundles')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const remoteSkills = normalizeSkills(payload)
      if (remoteSkills.length === 0) throw new Error('empty bundles')
      if (!mounted.current) return
      setSkills(remoteSkills)
      setSkillSource(normalizeSkillSource(payload))
      setSkillSourceState('ok')
    } catch {
      if (!mounted.current) return
      setSkills(FALLBACK_SKILLS)
      setSkillSource(null)
      setSkillSourceState('fallback')
    }
  }, [])

  useEffect(() => { void loadSkillBundles() }, [loadSkillBundles])

  useEffect(() => {
    let active = true
    apiRequest<{ prdAgentBaseUrl?: string }>('/api/config')
      .then((config) => {
        const runtimeOrigin = String(config.prdAgentBaseUrl || '').trim()
        if (active && runtimeOrigin) setPrdAgentOrigin(runtimeOrigin)
      })
      .catch(() => {})
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
  // 分类带条数：用户要先知道「这一类有多少」才决定点不点进去，
  // 光给类名等于让他一类一类试。第一项是「全部」，默认落在它上面。
  const skillGroups = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const skill of availableSkills) {
      const current = counts.get(skill.groupKey)
      if (current) current.count += 1
      else counts.set(skill.groupKey, { label: skill.groupLabel, count: 1 })
    }
    return [
      { key: ALL_SKILL_GROUP, label: '全部技能', count: availableSkills.length },
      ...[...counts].map(([key, value]) => ({ key, label: value.label, count: value.count })),
    ]
  }, [availableSkills])

  const librarySkills = useMemo(() => {
    const query = librarySearch.trim().toLowerCase()
    return availableSkills.filter((skill) => {
      if (activeSkillGroup !== ALL_SKILL_GROUP && skill.groupKey !== activeSkillGroup) return false
      if (!query) return true
      return `${skill.name} ${skill.description} ${skill.key}`.toLowerCase().includes(query)
    })
  }, [activeSkillGroup, availableSkills, librarySearch])

  const recommendedKeys = useMemo(() => recommendedSkills.map((skill) => skill.key), [recommendedSkills])

  useEffect(() => {
    setSelectedSkills(recommendedSkills.map((skill) => skill.key))
  }, [recommendedSkills])

  const selectedSkillItems = skills.filter((skill) => selectedSkills.includes(skill.key))
  const serviceOrigin = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
    ? String(import.meta.env.VITE_CDS_PUBLIC_BASE_URL || window.location.origin).trim()
    : window.location.origin
  const prompt = buildAgentStarterPrompt({
    experienceId,
    roleId,
    selectedSkillKeys: selectedSkillItems.map((skill) => skill.key),
    includeCds,
    cdsPrompt,
  })

  const roleProfile = AGENT_ROLE_PROFILES.find((item) => item.id === roleId) ?? AGENT_ROLE_PROFILES[0]
  const decisionCardModel = buildRoleDecisionCardModel(experienceId, roleId)
  const roleCardHarness = buildRoleCardHarness({ experienceId, roleId })

  const harness = buildAgentStarterHarness({
    experienceId,
    roleId,
    selectedSkillKeys: selectedSkillItems.map((skill) => skill.key),
    includeCds,
    cdsOrigin: serviceOrigin,
    prdAgentOrigin,
  })

  // 状态只对它当初写入的那个项目成立，换了目标就不再展示。
  const profileMatchesTarget = Boolean(projectId) && syncedProjectId === projectId
  // 当前目标项目还没记上角色（写失败，或换过目标之后没再写），需要给一条补写的出路。
  const needsProfileRetry = Boolean(projectId)
    && profileSync !== 'saving'
    && (profileMatchesTarget ? profileSync === 'failed' : Boolean(syncedProjectId))

  const advance = (nextStep: number) => {
    setCopied(false)
    setStep(nextStep)
  }

  const toggleSkill = (key: string): void => setSelectedSkills((current) =>
    current.includes(key) ? current.filter((item) => item !== key) : [...current, key])

  const openSkillLibrary = (): void => {
    setLibraryOpenedWith(selectedSkills)
    setLibrarySearch('')
    setActiveSkillGroup(ALL_SKILL_GROUP)
    setLibraryOpen(true)
  }

  // 放弃这次改动 = 还原成打开浮层那一刻的选择。没有这条路，用户在库里点花了
  // 就只能一个个点回去，而他根本不记得原来选的是哪几个。
  const cancelSkillLibrary = (): void => {
    setSelectedSkills(libraryOpenedWith)
    setLibraryOpen(false)
  }

  // 完成页的两块展开区互斥：同时展开会把主操作挤出可视区（那正是决策卡
  // 当初要「固定操作区 + 可滚预览区」的原因），两块一起来照样会撞上。
  const toggleDecisionCard = (): void => {
    setShowSkillSource(false)
    setShowDecisionCard((value) => !value)
  }
  const toggleSkillSource = (): void => {
    setShowDecisionCard(false)
    setShowSkillSource((value) => !value)
  }

  const completionExpanded = showDecisionCard || showSkillSource
  const panelTall = completionExpanded || (step === 2 && libraryOpen)

  // 生成上手包 = 用户确认了这套配置，此时把角色声明记到项目上，
  // 让 CDS 侧也知道这个项目的 Agent 以什么角色在跑（此前只写进仓库文件，无人读取）。
  // 失败不拦流程：这只是一条展示用的声明，不该挡住用户拿提示词。
  //
  // 只在点「生成」这一下写，不挂 effect 跟着 projectId 变：完成屏上项目选择器
  // 仍然可用，用 effect 的话，给项目 A 生成完再切到项目 B，就会把 A 的角色
  // 静默盖到 B 头上——用户从没为 B 确认过任何东西。
  const syncAgentProfile = (targetProjectId?: string): void => {
    if (!targetProjectId) return
    // 每次写入领一个号，回调只认自己那一号。慢网下可以「给 A 生成 → 换到 B →
    // 再生成」，此时 A 的响应可能后于 B 落地；两个回调写同一个无主的状态位，
    // 就会用 A 的结果报告 B 的成败。状态位只该由最后一次写入的回调来动。
    const ticket = profileSyncTicket.current + 1
    profileSyncTicket.current = ticket
    setSyncedProjectId(targetProjectId)
    setProfileSync('saving')
    const settle = (next: 'saved' | 'failed'): void => {
      if (profileSyncTicket.current !== ticket) return
      setProfileSync(next)
    }
    apiRequest(`/api/projects/${encodeURIComponent(targetProjectId)}/agent-profile`, {
      method: 'PUT',
      body: {
        role: roleId,
        experience: experienceId,
        skills: selectedSkillItems.map((skill) => skill.key),
        cardTitle: roleProfile.cardTitle,
      },
    })
      .then(() => settle('saved'))
      .catch(() => settle('failed'))
  }

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
  }

  return (
    <div
      data-agent-starter="true"
      /*
       * 展开决策卡时面板长高一档：12 段清单在 560px 里只能分到几十像素。
       * max-h 必须按**弹窗内的可用高度**算，不是按视口：弹窗自己是 90vh，
       * 其上还有标题、目标选择和 tab 条约 220px。原来写的 calc(100vh-190px)
       * 根本不生效，760px 直接捅出弹窗底 74px（真机量出来的）。
       */
      className={`relative flex max-h-[calc(90vh-224px)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] text-foreground shadow-[0_20px_70px_rgba(0,0,0,0.18)] transition-[height] duration-200 ${panelTall ? 'h-[760px]' : 'h-[560px]'}`}
    >
      <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-7 py-5">
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
                <div className={`h-2.5 rounded-full transition-all duration-300 ${index === step ? 'w-9 bg-warn' : index < step ? 'w-2.5 bg-[hsl(var(--foreground-muted))]' : 'w-2.5 bg-[hsl(var(--hairline-strong))]'}`} />
                {index === step && <span className="ml-1 text-xs font-semibold text-muted-foreground">{label}</span>}
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
                <div className="mt-5 grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto pb-14 pr-1 lg:grid-cols-3">
                  {AGENT_ROLE_PROFILES.map((profile) => {
                    const Icon = roleIcons[profile.id]
                    return (
                      <ChoiceCard
                        key={profile.id}
                        selected={roleId === profile.id}
                        title={profile.label}
                        description={profile.description}
                        chips={profile.decisionFields}
                        icon={<Icon className="h-5 w-5" />}
                        compact
                        onClick={() => { setRoleId(profile.id); advance(2) }}
                      />
                    )
                  })}
                </div>
              </>
            )}

            {/*
              * 这一屏只有一种形态：角色推荐 + 一个「确认这些技能」。
              *
              * 原来它有两种形态，靠 showSkillLibrary 原地互换：进技能库时推荐的技能
              * 被整片换掉，主按钮被那个开关条件渲染掉，出口只剩一个和入口同款同位的
              * 次要按钮。三件事叠起来，用户在这一屏找不到任何前进的路，只能兜圈子。
              * 技能库因此改成浮层：推荐页原样留在底下，出口是关闭 / 放弃 / 完成
              * 三个大家都认识的动作。守卫见 tests/web/agent-starter-skill-library-contract。
              */}
            {step === 2 && (
              <>
                <StepHeading
                  number="03"
                  title="带上哪些工作方法？"
                  description="已经按你的角色选好。可以取消，也可以打开技能库按类别增加更多。"
                />
                <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                  {recommendedSkills.map((skill) => (
                    <SkillCard
                      key={skill.key}
                      skill={skill}
                      selected={selectedSkills.includes(skill.key)}
                      recommended
                      onToggle={() => toggleSkill(skill.key)}
                    />
                  ))}
                </div>
                {/*
                  * 返回按钮在这一屏走行内，不用面板底部那个绝对定位的。
                  * 那个按钮固定在 bottom-5 left-8，而这一屏的底栏是最后一个流式子元素，
                  * 两者正好叠在一起——「返回」压着「已选择 N 项」。步骤 02 是靠网格
                  * 的 pb-14 给它让位的，这一屏没有任何东西让位。
                  */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] pt-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => advance(1)}
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
                    >
                      <ArrowLeft className="h-4 w-4" /> 返回
                    </button>
                    <span className="text-sm font-medium text-muted-foreground">已选择 {selectedSkills.length} 项</span>
                    <button
                      type="button"
                      onClick={openSkillLibrary}
                      className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-2 text-sm font-bold text-foreground hover:border-[hsl(var(--hairline-strong))]"
                    >
                      打开技能库（共 {availableSkills.length} 项）
                    </button>
                  </div>
                  <PrimaryNext onClick={() => advance(3)}>确认这些技能</PrimaryNext>
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
                    className={`w-full max-w-2xl rounded-2xl border-2 p-7 text-left transition-all ${includeCds ? 'border-warn bg-warn-soft shadow-[0_18px_50px_rgba(194,91,33,0.15)]' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]'}`}
                  >
                    <div className="flex items-start gap-5">
                      <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${includeCds ? 'bg-warn text-status-ink' : 'bg-[hsl(var(--surface-sunken))] text-muted-foreground'}`}>
                        <WandSparkles className="h-6 w-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-4">
                          <h4 className="text-lg font-bold">接入 CDS，自动给预览地址</h4>
                          <span className={`rounded-full px-3 py-1 text-xs font-bold ${includeCds ? 'bg-warn text-status-ink' : 'bg-[hsl(var(--surface-sunken))] text-muted-foreground'}`}>{includeCds ? '已开启' : '未开启'}</span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">自动处理项目扫描、分支部署、真实预览地址和登录验收。你不需要先准备任何密钥：Agent 会在需要授权时发起申请，你在页面点一下批准即可。需要账号时，Agent 会验证后再交付安全的临时账号。</p>
                      </div>
                    </div>
                  </button>
                </div>
                <div className="mt-4 flex justify-end border-t border-[hsl(var(--hairline))] pt-4">
                  <PrimaryNext onClick={() => { advance(4); syncAgentProfile(projectId) }}>生成我的上手包</PrimaryNext>
                </div>
              </>
            )}

            {/*
             * 完成页是「固定操作区 + 可滚预览区」，不是整页一起滚。
             * 整页滚的时候，一展开决策卡就把标题和「复制启动提示词」顶出可视区，
             * 用户只剩一张没有抬头、没有按钮的表格（真机撞到过）。
             * 主操作永远钉住，滚动只发生在预览卡自己身上。
             */}
            {step === 4 && (
              <div className="flex h-full min-h-0 flex-col">
                <div className={`flex shrink-0 flex-col items-center text-center ${completionExpanded ? 'pt-1' : 'my-auto py-2'}`}>
                {!completionExpanded && (
                  <motion.div initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="grid h-14 w-14 place-items-center rounded-2xl bg-foreground text-background shadow-xl">
                    <Check className="h-7 w-7" />
                  </motion.div>
                )}
                {!completionExpanded && (
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="mb-3 inline-flex min-h-11 items-center gap-2 self-start rounded-xl px-3 text-sm font-semibold text-muted-foreground hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    返回修改
                  </button>
                )}
                <h4 className={completionExpanded ? 'text-base font-bold tracking-tight' : 'mt-5 text-2xl font-bold tracking-tight'}>
                  你的 Agent 上手包已经配好
                </h4>
                {!completionExpanded && (
                  <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{selectedSkills.length} 项工作方法{includeCds ? '，另含 CDS 接入与真实预览能力' : ''}。复制后直接发给项目里的 Agent。</p>
                )}
                <p className={`text-xs text-muted-foreground ${completionExpanded ? 'sr-only' : 'mt-2'}`} aria-live="polite">
                  {!projectId
                    ? `还没有选定项目，角色「${roleProfile.label}」只写进项目里的长期规则，CDS 这边暂不记录。等 Agent 把项目建好，回到这一步再生成一次就会记上。`
                    : null}
                  {profileMatchesTarget && profileSync === 'saving' ? '正在把角色记到项目…' : null}
                  {profileMatchesTarget && profileSync === 'saved'
                    ? `已记到项目：这个项目的 Agent 角色是「${roleProfile.label}」，回复用${roleProfile.cardTitle}。`
                    : null}
                  {profileMatchesTarget && profileSync === 'failed'
                    ? '角色没能记到项目（不影响使用提示词），项目列表里暂时不会显示角色。'
                    : null}
                  {projectId && syncedProjectId && syncedProjectId !== projectId
                    ? '刚才换了目标项目，这个项目还没记过角色。'
                    : null}
                </p>

                {/*
                 * 没记上就得有条出路：写失败、或换了目标项目，这两种状态原先都是死胡同——
                 * 复制提示词和下载脚本都不会补写，用户只能带着「这个项目没有角色」离开。
                 * 文案更不能指一个不存在的按钮，那是凭空编一个控件让人去找。
                 */}
                {needsProfileRetry ? (
                  <button
                    type="button"
                    onClick={() => syncAgentProfile(projectId)}
                    className="mt-2 inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--hairline))] px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))]"
                  >
                    <RefreshCw className="h-4 w-4" />
                    {profileSync === 'failed' && profileMatchesTarget ? '重试记录角色' : '把角色记到这个项目'}
                  </button>
                ) : null}

                <motion.button
                  type="button"
                  onClick={copyPrompt}
                  animate={reduceMotion || copied ? undefined : {
                    scale: [1, 1.025, 1],
                    boxShadow: ['0 16px 45px rgba(194,91,33,0.22)', '0 22px 60px rgba(194,91,33,0.38)', '0 16px 45px rgba(194,91,33,0.22)'],
                  }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                  className={`flex min-w-[300px] items-center justify-center gap-3 rounded-2xl px-8 font-bold transition-colors ${completionExpanded ? 'mt-4 py-3 text-sm' : 'mt-7 py-4 text-base'} ${copied ? 'bg-ok text-status-ink' : 'agent-starter-copy bg-warn hover:bg-warn'}`}
                >
                  {copied ? <Check className="h-5 w-5" /> : <ClipboardCopy className="h-5 w-5" />}
                  {copied ? '已复制，现在交给 Agent' : '复制启动提示词'}
                  {!copied && <ArrowRight className="h-5 w-5" />}
                </motion.button>

                <div className={`flex flex-wrap items-center justify-center gap-3 ${completionExpanded ? 'mt-3' : 'mt-5'}`}>
                  <button type="button" onClick={() => downloadText('cds-agent-starter.sh', harness)} className="inline-flex items-center gap-2 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-2.5 text-sm font-semibold text-foreground hover:border-[hsl(var(--hairline-strong))]">
                    <Download className="h-4 w-4" /> 下载一键脚本
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadText('cds-agent-role-card.sh', roleCardHarness)}
                    title="已经装过上手包时用它：只替换角色决策卡，不重下技能、不碰 .env"
                    className="inline-flex items-center gap-2 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-2.5 text-sm font-semibold text-foreground hover:border-[hsl(var(--hairline-strong))]"
                  >
                    <RefreshCw className="h-4 w-4" /> 只换角色卡
                  </button>
                  <button
                    type="button"
                    onClick={toggleDecisionCard}
                    aria-expanded={showDecisionCard}
                    className="inline-flex items-center gap-2 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-2.5 text-sm font-semibold text-foreground hover:border-[hsl(var(--hairline-strong))]"
                  >
                    <FileText className="h-4 w-4" /> {showDecisionCard ? '收起' : '预览'}「{roleProfile.cardTitle}」
                  </button>
                  {/*
                    * 原来这里是一个直接指向 /api/skills/bundles 的外链——点一下把接口的
                    * 裸 JSON 甩给用户。用户问的不是「响应体长什么样」，是「这些技能哪来的、
                    * 是不是完整的、我还能不能装」。所以改成就地展开一块面板来回答，
                    * 原始 JSON 降级成面板角落里给排障用的小入口。
                    */}
                  <button
                    type="button"
                    onClick={toggleSkillSource}
                    aria-expanded={showSkillSource}
                    className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ${showSkillSource ? 'border-warn bg-warn-soft text-warn' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-foreground hover:border-[hsl(var(--hairline-strong))]'}`}
                  >
                    <Server className="h-4 w-4" />
                    技能来源
                    {skillSourceState === 'fallback' && (
                      <span className="rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-bold text-status-ink">读不到</span>
                    )}
                    {showSkillSource ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                </div>

                {showDecisionCard && (
                  <div className="mt-3 flex min-h-[220px] flex-1 justify-center overflow-hidden pb-1">
                    <DecisionCardPreview model={decisionCardModel} />
                  </div>
                )}

                {showSkillSource && (
                  <div className="mt-3 flex min-h-[220px] flex-1 justify-center overflow-hidden pb-1">
                    <SkillSourcePanel
                      state={skillSourceState}
                      source={skillSource}
                      fallbackCount={FALLBACK_SKILLS.length}
                      rawUrl={`${serviceOrigin}/api/skills/bundles`}
                      onRetry={() => { void loadSkillBundles() }}
                      onOpenMarketplace={onOpenMarketplace}
                    />
                  </div>
                )}
              </div>
            )}
          </motion.section>
        </AnimatePresence>
      </div>

      {/* 步骤 03 的返回在它自己的底栏里（见上），这里排除它，否则两个返回并存。 */}
      {step > 0 && step < 4 && step !== 2 && (
        <div className="absolute bottom-5 left-8">
          <button type="button" onClick={() => advance(step - 1)} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
        </div>
      )}

      {step === 2 && libraryOpen && (
        <div className="absolute inset-0 z-20 flex flex-col bg-[hsl(var(--surface-sunken)/0.78)] p-3 sm:p-5">
          <SkillLibrarySheet
            groups={skillGroups}
            activeGroup={activeSkillGroup}
            onActiveGroup={setActiveSkillGroup}
            query={librarySearch}
            onQuery={setLibrarySearch}
            visibleSkills={librarySkills}
            totalCount={availableSkills.length}
            selectedKeys={selectedSkills}
            openedWith={libraryOpenedWith}
            recommendedKeys={recommendedKeys}
            onToggle={toggleSkill}
            onCancel={cancelSkillLibrary}
            onDone={() => setLibraryOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

/*
 * 决策卡预览：四层分区（卡头 / 前言 / 编号段落清单 / 禁止项）。
 *
 * 内容全部取自 buildRoleDecisionCardModel，与写进 AGENTS.md 的文本契约同源，
 * 所以这里只决定「怎么排」，改不动段名和规则本身。角色专属段落染主色、
 * 共享段落保持中性——「哪几段是这个角色独有的」变成一眼可见。
 */
function DecisionCardPreview({ model }: { model: AgentDecisionCardModel }) {
  return (
    <div className="flex min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-left">
      <div className="flex shrink-0 items-center gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
        <span className="h-7 w-[3px] shrink-0 rounded-sm bg-warn" />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{model.cardTitle}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {model.roleLabel} · 换角色会换成另一套段落
          </div>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-[hsl(var(--surface-sunken))] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          {model.sectionCount} 段
        </span>
      </div>

      <dl className="grid shrink-0 gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2.5 text-[11px] leading-relaxed">
          <dt className="font-semibold text-muted-foreground">理解方向</dt>
          <dd>{model.lens}</dd>
        </div>
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2.5 text-[11px] leading-relaxed">
          <dt className="font-semibold text-muted-foreground">先确认</dt>
          <dd>{model.intake.join('；')}</dd>
        </div>
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2.5 text-[11px] leading-relaxed">
          <dt className="font-semibold text-muted-foreground">关注点</dt>
          <dd className="flex flex-wrap gap-1.5">
            {model.decisionFields.map((field) => (
              <span key={field} className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium">
                {field}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      {/* 段落清单是卡内唯一滚动区：卡头与前言钉住，滚多远都还知道这是哪张卡。 */}
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {model.sections.map((section, index) => (
          <li
            key={section.label}
            className={`grid grid-cols-[1.75rem_6rem_minmax(0,1fr)] gap-2.5 px-4 py-1.5 text-[11px] leading-relaxed ${section.roleSpecific ? 'bg-warn-soft' : ''}`}
          >
            <span className={`font-mono text-[10px] ${section.roleSpecific ? 'text-warn' : 'text-muted-foreground/70'}`}>
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className={`font-semibold ${section.roleSpecific ? 'text-warn' : ''}`}>{section.label}</span>
            <span className="text-muted-foreground">{section.rule}</span>
          </li>
        ))}
      </ol>

      <div className="flex shrink-0 items-start gap-2 border-t border-[hsl(var(--hairline))] bg-bad-soft px-4 py-2.5">
        <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
        <div className="text-[11px] leading-relaxed">
          <span className="font-semibold text-bad">本角色额外禁止</span>
          <span> {model.roleForbid.join('；')}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 一张技能卡。推荐页和技能库共用同一张——同一件事写成两份，早晚只改一边。
 */
export function SkillCard({ skill, selected, recommended, justAdded, onToggle }: {
  skill: { key: string; name: string; description: string }
  selected: boolean
  recommended?: boolean
  justAdded?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={`group relative rounded-xl border p-4 text-left transition-all ${selected ? 'border-warn bg-warn-soft text-foreground shadow-[0_8px_24px_rgba(194,91,33,0.12)]' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-foreground hover:border-[hsl(var(--hairline-strong))]'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <PackageCheck className={`h-5 w-5 ${selected ? 'text-warn' : 'text-muted-foreground'}`} />
        <span className={`grid h-5 w-5 place-items-center rounded-full border ${selected ? 'border-warn bg-warn text-status-ink' : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))]'}`}>
          {selected && <Check className="h-3.5 w-3.5" />}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-bold">{skill.name}</span>
        {justAdded && (
          <span className="rounded-full border border-ok bg-ok-soft px-1.5 py-px text-[10px] font-bold text-ok">刚加上</span>
        )}
        {!justAdded && recommended && (
          <span className="rounded-full bg-warn px-1.5 py-px text-[10px] font-bold text-status-ink">角色推荐</span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description}</p>
    </button>
  )
}

export interface SkillLibrarySheetProps {
  groups: readonly { key: string; label: string; count: number }[]
  activeGroup: string
  onActiveGroup: (key: string) => void
  query: string
  onQuery: (value: string) => void
  visibleSkills: readonly StarterSkill[]
  totalCount: number
  selectedKeys: readonly string[]
  /** 打开浮层那一刻的选择，用来算「刚加上」和支撑「放弃这次改动」。 */
  openedWith: readonly string[]
  recommendedKeys: readonly string[]
  onToggle: (key: string) => void
  onCancel: () => void
  onDone: () => void
}

/**
 * 技能库浮层。
 *
 * 三个出口都在这里：右上角关闭、底栏「放弃这次改动」、底栏「完成选择」。
 * 关闭与完成都保留勾选（勾选是即时生效的，背后的推荐页当场就变），
 * 只有「放弃这次改动」会还原——所以没有任何一个出口会让人意外丢东西。
 */
export function SkillLibrarySheet({
  groups, activeGroup, onActiveGroup, query, onQuery, visibleSkills, totalCount,
  selectedKeys, openedWith, recommendedKeys, onToggle, onCancel, onDone,
}: SkillLibrarySheetProps) {
  const summary = summarizeSkillSelection({ selected: selectedKeys, openedWith })
  const changeNote = summary.added === 0 && summary.removed === 0
    ? '还没有改动'
    : [summary.added > 0 ? `新加 ${summary.added} 项` : '', summary.removed > 0 ? `去掉 ${summary.removed} 项` : '']
      .filter(Boolean)
      .join('，')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] shadow-[0_28px_80px_rgba(0,0,0,0.35)]">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[hsl(var(--hairline))] px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <div className="min-w-0">
            <div className="text-base font-bold">技能库</div>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">关掉它就回到推荐页，这里勾的技能会一起带回去。</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDone}
          aria-label="关闭技能库"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* 分类：手机横排可滚，桌面竖列。窄屏不做竖列——那会把本就不宽的网格再切一刀。 */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          role="tablist"
          aria-label="技能分类"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-[hsl(var(--hairline))] p-2 lg:w-52 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-2.5"
        >
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              role="tab"
              aria-selected={activeGroup === group.key}
              onClick={() => onActiveGroup(group.key)}
              className={`flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors ${activeGroup === group.key ? 'bg-warn-soft text-warn' : 'text-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}
            >
              <span>{group.label}</span>
              <span className="cds-ident text-[11px] opacity-70">{group.count}</span>
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-4 lg:p-5">
          <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="搜索技能名称或用途"
              aria-label="搜索技能"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>

          {visibleSkills.length === 0 ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">这一类里没有匹配「{query}」的技能。</p>
              <button
                type="button"
                onClick={() => onQuery('')}
                className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-2 text-sm font-semibold text-foreground hover:border-[hsl(var(--hairline-strong))]"
              >
                清除搜索
              </button>
            </div>
          ) : (
            <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {visibleSkills.map((skill) => {
                const selected = selectedKeys.includes(skill.key)
                return (
                  <SkillCard
                    key={skill.key}
                    skill={skill}
                    selected={selected}
                    recommended={recommendedKeys.includes(skill.key)}
                    justAdded={selected && !openedWith.includes(skill.key)}
                    onToggle={() => onToggle(skill.key)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-5 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-bold">已选择 {summary.total} 项</div>
          <div className="mt-px text-xs text-muted-foreground">共 {totalCount} 项可选 · 这次{changeNote}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-2.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            放弃这次改动
          </button>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex items-center gap-2 rounded-xl bg-warn px-5 py-2.5 text-sm font-bold text-status-ink transition-transform hover:-translate-y-0.5"
          >
            完成选择 <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 技能来源面板。回答的是用户的三个问题：这些技能哪来的、是不是完整的、我还能不能装。
 *
 * 每一行都必须有真实来源：服务端报什么就显示什么，没报出来就说没报出来，
 * 不用 0 或者「未知版本」把空位填上。原始 JSON 留在角落给排障用。
 */
export function SkillSourcePanel({ state, source, fallbackCount, rawUrl, onRetry, onOpenMarketplace }: {
  state: SkillSourceState
  source: SkillSourceInfo | null
  /** 读不到时页面用的兜底清单条数，用来如实告诉用户「你现在看到的是这份」。 */
  fallbackCount: number
  rawUrl: string
  onRetry: () => void
  onOpenMarketplace?: () => void
}) {
  const badge = state === 'loading'
    ? { text: '正在读取', className: 'bg-[hsl(var(--surface-sunken))] text-muted-foreground' }
    : state === 'fallback'
      ? { text: '读不到来源', className: 'bg-warn-soft text-warn' }
      : { text: '可用', className: 'bg-ok-soft text-ok' }

  return (
    <div className="flex min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-left">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Server className="h-4 w-4 shrink-0 text-warn" />
          <span className="text-sm font-semibold">技能来源</span>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${badge.className}`}>{badge.text}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state === 'fallback' && (
          <>
            <div className="flex items-start gap-2 border-b border-[hsl(var(--hairline))] bg-warn-soft px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <p className="text-xs leading-5">
                没能从这台 CDS 读到技能清单。现在这一屏用的是页面自带的兜底清单（{fallbackCount} 项），
                可能比真实清单少。复制出去的提示词照常可用，但里面的技能名可能装不全。
              </p>
            </div>
            <div className="px-4 py-3">
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs font-bold text-foreground hover:border-[hsl(var(--hairline-strong))]"
              >
                <RefreshCw className="h-4 w-4" /> 重新读一次
              </button>
            </div>
          </>
        )}

        {state === 'loading' && (
          <p className="px-4 py-4 text-xs text-muted-foreground">正在读取技能清单…</p>
        )}

        {state === 'ok' && !source && (
          <p className="px-4 py-4 text-xs leading-5 text-muted-foreground">
            清单读到了，但这台 CDS 没有报出来源信息（多半是较旧的版本）。
            技能本身可以正常安装，只是这里说不出它们的出处。
          </p>
        )}

        {state === 'ok' && source && (
          <>
            <dl className="grid gap-2 px-4 py-3">
              <SourceRow label="来源" value={source.kind === 'builtin' ? '随 CDS 版本发布的内置清单' : source.kind} />
              <SourceRow label="清单" value={`${source.bundleCount} 类 · ${source.skillCount} 个技能`} />
              <SourceRow
                label="离线"
                value={source.upstreamSkillCount === 0
                  ? `${source.localSkillCount} 个全部由这台 CDS 自带，断网也装得上`
                  : `${source.localSkillCount} 个这台 CDS 自带，另外 ${source.upstreamSkillCount} 个要回源才装得上`}
              />
            </dl>
            {source.upstreamSkillCount > 0 && !source.upstreamConfigured && (
              <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <p className="text-xs leading-5">
                  这 {source.upstreamSkillCount} 个技能需要回源，但这台 CDS 没有配置上游，装到它们会失败。
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-2.5">
        {onOpenMarketplace ? (
          <button
            type="button"
            onClick={onOpenMarketplace}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-warn hover:underline"
          >
            在技能市场里逐个看 <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : <span />}
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          title="给排障用的接口原始返回"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Braces className="h-3.5 w-3.5" /> 原始数据
        </a>
      </div>
    </div>
  )
}

function SourceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 text-xs leading-5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  )
}

function StepHeading({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="flex items-start gap-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warn-soft text-sm font-black text-warn">{number}</span>
      <div>
        <h4 className="text-xl font-bold tracking-tight text-foreground">{title}</h4>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function ChoiceCard({ selected, title, eyebrow, description, chips, icon, compact = false, onClick }: {
  selected: boolean
  title: string
  eyebrow?: string
  description: string
  chips?: readonly string[]
  icon?: React.ReactNode
  compact?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex min-h-0 flex-col justify-between rounded-2xl border-2 text-left transition-all duration-200 ${compact ? 'p-4' : 'p-6'} ${selected ? 'border-warn bg-warn-soft shadow-[0_14px_40px_rgba(194,91,33,0.13)]' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] hover:-translate-y-0.5 hover:border-[hsl(var(--hairline-strong))] hover:shadow-lg'}`}
    >
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className={`grid h-9 w-9 place-items-center rounded-xl ${selected ? 'bg-warn text-status-ink' : 'bg-[hsl(var(--surface-sunken))] text-muted-foreground'}`}>{icon ?? <UserRound className="h-5 w-5" />}</div>
          <span className={`grid h-6 w-6 place-items-center rounded-full border ${selected ? 'border-warn bg-warn text-status-ink' : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))]'}`}>{selected && <Check className="h-4 w-4" />}</span>
        </div>
        <h5 className={`${compact ? 'mt-3 text-base' : 'mt-5 text-xl'} font-bold text-foreground`}>{title}</h5>
        {eyebrow && <div className="mt-1 text-xs font-bold uppercase tracking-wide text-warn">{eyebrow}</div>}
        <p className={`${compact ? 'mt-2 text-xs leading-5' : 'mt-3 text-sm leading-6'} text-muted-foreground`}>{description}</p>
        {chips && chips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {chips.map((chip) => (
              <span
                key={chip}
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${selected ? 'bg-warn text-status-ink' : 'bg-[hsl(var(--surface-sunken))] text-muted-foreground'}`}
              >
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>
      {!compact && (
        <div className="mt-3 flex items-center gap-1 text-xs font-bold text-foreground opacity-0 transition-opacity group-hover:opacity-100">选择并继续 <ArrowRight className="h-3.5 w-3.5" /></div>
      )}
    </button>
  )
}

function PrimaryNext({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-bold text-background shadow-lg transition-transform hover:-translate-y-0.5 hover:opacity-90">
      {children} <ArrowRight className="h-4 w-4" />
    </button>
  )
}

export default AgentStarterTab
