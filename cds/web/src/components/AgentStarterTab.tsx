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
}

const STEPS = ['经验', '角色', '技能', '交付', '开始'] as const

const FALLBACK_SKILLS: StarterSkill[] = [
  { key: 'skill-validation', name: '需求澄清', description: '发现模糊、遗漏和不可验收的需求。', roles: ['pm', 'owner', 'domain-expert'] },
  { key: 'plan-first', name: '先出方案', description: '动手前先说明路径、影响和取舍。', roles: ['pm', 'owner', 'dev'] },
  { key: 'acceptance-checklist', name: '验收清单', description: '把结果变成可以逐项确认的步骤。', roles: ['pm', 'domain-expert', 'qa'] },
  { key: 'risk-matrix', name: '风险矩阵', description: '提前识别业务、体验和上线风险。', roles: ['owner', 'domain-expert', 'qa'] },
  { key: 'flow-trace', name: '流程追踪', description: '用大白话解释功能从页面到数据的过程。', roles: ['pm', 'dev', 'qa'] },
  { key: 'preview-url', name: '真实预览地址', description: '部署后读取 CDS 返回的真实访问地址。', roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'] },
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
    for (const skill of skills) {
      const key = typeof skill === 'string' ? skill : skill?.key ?? skill?.id
      if (!key || results.some((item) => item.key === key)) continue
      results.push({
        key,
        name: typeof skill === 'string' ? skill : skill?.name ?? skill?.label ?? key,
        description: typeof skill === 'string' ? '为当前角色补充一项可执行能力。' : skill?.description ?? '为当前角色补充一项可执行能力。',
        roles: (Array.isArray(skill?.roles) ? skill.roles : bundleRoles) as AgentRoleId[],
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
    const matched = skills.filter((skill) => skill.roles.length === 0 || skill.roles.includes(roleId))
    return (matched.length > 0 ? matched : FALLBACK_SKILLS.filter((skill) => skill.roles.includes(roleId))).slice(0, 6)
  }, [roleId, skills])

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
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-orange-700">
              <Sparkles className="h-4 w-4" /> Agent Starter
            </div>
            <h3 className="mt-1 text-xl font-semibold tracking-tight">一句话改项目，一个地址看效果</h3>
          </div>
          <div className="hidden items-center gap-1 sm:flex">
            {STEPS.map((label, index) => (
              <div key={label} className="flex items-center gap-1">
                <div className={`h-2.5 rounded-full transition-all duration-300 ${index === step ? 'w-9 bg-orange-600' : index < step ? 'w-2.5 bg-stone-800' : 'w-2.5 bg-stone-200'}`} />
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
                <StepHeading number="03" title="带上哪些工作方法？" description="已经按你的角色选好。点一下可以取消，稍后也能去海鲜市场增加。" />
                <div className="mt-5 grid flex-1 grid-cols-2 gap-3 lg:grid-cols-3">
                  {recommendedSkills.map((skill) => {
                    const selected = selectedSkills.includes(skill.key)
                    return (
                      <button
                        key={skill.key}
                        type="button"
                        onClick={() => setSelectedSkills((current) => selected ? current.filter((key) => key !== skill.key) : [...current, skill.key])}
                        className={`group relative rounded-xl border p-4 text-left transition-all ${selected ? 'border-orange-500 bg-orange-50 text-stone-950 shadow-[0_8px_24px_rgba(194,91,33,0.12)]' : 'border-stone-300 bg-white text-stone-800 hover:border-stone-500'}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <PackageCheck className={`h-5 w-5 ${selected ? 'text-orange-700' : 'text-stone-500'}`} />
                          <span className={`grid h-5 w-5 place-items-center rounded-full border ${selected ? 'border-orange-600 bg-orange-600 text-white' : 'border-stone-400 bg-white'}`}>
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
                  <span className="text-sm font-medium text-stone-700">已选择 {selectedSkills.length} 项</span>
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
                    className={`w-full max-w-2xl rounded-2xl border-2 p-7 text-left transition-all ${includeCds ? 'border-orange-600 bg-orange-50 shadow-[0_18px_50px_rgba(194,91,33,0.15)]' : 'border-stone-300 bg-white'}`}
                  >
                    <div className="flex items-start gap-5">
                      <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${includeCds ? 'bg-orange-600 text-white' : 'bg-stone-200 text-stone-600'}`}>
                        <WandSparkles className="h-6 w-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-4">
                          <h4 className="text-lg font-bold">接入 CDS，自动给预览地址</h4>
                          <span className={`rounded-full px-3 py-1 text-xs font-bold ${includeCds ? 'bg-orange-600 text-white' : 'bg-stone-200 text-stone-700'}`}>{includeCds ? '已开启' : '未开启'}</span>
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
                  className={`mt-7 flex min-w-[300px] items-center justify-center gap-3 rounded-2xl px-8 py-4 text-base font-bold text-white transition-colors ${copied ? 'bg-emerald-700' : 'agent-starter-copy bg-orange-700 hover:bg-orange-800'}`}
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
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-orange-100 text-sm font-black text-orange-800">{number}</span>
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
      className={`group relative flex min-h-0 flex-col justify-between rounded-2xl border-2 text-left transition-all duration-200 ${compact ? 'p-4' : 'p-6'} ${selected ? 'border-orange-600 bg-orange-50 shadow-[0_14px_40px_rgba(194,91,33,0.13)]' : 'border-stone-300 bg-white hover:-translate-y-0.5 hover:border-stone-600 hover:shadow-lg'}`}
    >
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className={`grid h-9 w-9 place-items-center rounded-xl ${selected ? 'bg-orange-600 text-white' : 'bg-stone-100 text-stone-700'}`}>{icon ?? <UserRound className="h-5 w-5" />}</div>
          <span className={`grid h-6 w-6 place-items-center rounded-full border ${selected ? 'border-orange-600 bg-orange-600 text-white' : 'border-stone-400 bg-white'}`}>{selected && <Check className="h-4 w-4" />}</span>
        </div>
        <h5 className={`${compact ? 'mt-3 text-base' : 'mt-5 text-xl'} font-bold text-stone-950`}>{title}</h5>
        {eyebrow && <div className="mt-1 text-xs font-bold uppercase tracking-wide text-orange-800">{eyebrow}</div>}
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
