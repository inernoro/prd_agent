export type AgentMissionScope = 'system' | 'project';

export type AgentMissionCategoryId =
  | 'access'
  | 'inspect'
  | 'deploy'
  | 'integrate'
  | 'code'
  | 'operate'
  | 'deliver';

export type AgentMissionIconKey =
  | 'api'
  | 'auth'
  | 'branch'
  | 'check'
  | 'code'
  | 'database'
  | 'github'
  | 'health'
  | 'key'
  | 'logs'
  | 'maintenance'
  | 'preview'
  | 'project'
  | 'release'
  | 'rollback'
  | 'schedule'
  | 'service'
  | 'settings'
  | 'startup';

export type AgentPageContextId =
  | 'agent-access'
  | 'auth'
  | 'github'
  | 'projects'
  | 'system-health'
  | 'system-observability'
  | 'maintenance'
  | 'settings'
  | 'project-onboarding'
  | 'code-review'
  | 'branches'
  | 'build-diagnostics'
  | 'startup-diagnostics'
  | 'log-diagnostics'
  | 'api-diagnostics'
  | 'preview-diagnostics'
  | 'project-settings'
  | 'service-integration'
  | 'env-diagnostics'
  | 'release'
  | 'rollback'
  | 'tasks'
  | 'reports'
  | 'general';

export interface AgentMissionCategoryDefinition {
  id: AgentMissionCategoryId;
  label: string;
  description: string;
}

export interface AgentMissionDefinition {
  id: AgentPageContextId;
  categoryId: AgentMissionCategoryId;
  scope: AgentMissionScope;
  icon: AgentMissionIconKey;
  shortLabel: string;
  cardDescription: string;
  title: string;
  summary: string;
  goal: string;
  steps: string[];
  checks: string[];
  completion: string[];
  pagePath: (projectId?: string) => string;
}

export interface AgentPageContext extends Omit<AgentMissionDefinition, 'pagePath'> {
  pagePath: string;
}

function projectPath(prefix: string, projectId?: string): string {
  return `${prefix}/${encodeURIComponent(projectId || '<project-id>')}`;
}

export const AGENT_MISSION_CATEGORY_DEFINITIONS: readonly AgentMissionCategoryDefinition[] = [
  { id: 'access', label: '接入与授权', description: '身份、项目绑定与权限范围' },
  { id: 'inspect', label: '状态与排障', description: '健康状态、日志和异常定位' },
  { id: 'deploy', label: '部署与预览', description: '构建、启动和公开入口' },
  { id: 'integrate', label: '项目与服务', description: '仓库、配置和依赖服务' },
  { id: 'code', label: '代码与接口', description: '代码检查和重要接口诊断' },
  { id: 'operate', label: '维护与恢复', description: '更新、回滚和任务调度' },
  { id: 'deliver', label: '发布与验收', description: '正式发布和证据归档' },
] as const;

/**
 * CDS Agent 任务与提示词的唯一注册表。
 *
 * 新增或调整任务时只改这里。界面、页面上下文和接入口令都从该注册表读取，
 * 避免同一个任务在多个组件中出现不同的目标、安全边界或完成标准。
 */
export const AGENT_MISSION_DEFINITIONS: Record<AgentPageContextId, AgentMissionDefinition> = {
  'agent-access': {
    id: 'agent-access',
    categoryId: 'access',
    scope: 'system',
    icon: 'key',
    shortLabel: 'Agent 授权与提权',
    cardDescription: '静默复用、项目授权、跨项目提权',
    title: 'Agent 授权与提权',
    summary: '先静默复用已有凭据，只有缺少目标项目权限时才申请授权；跨项目长期操作必须明确提权。',
    goal: '判断当前 Agent 对目标项目的实际权限，采用最小范围完成接入，并解释项目级、一次性和全局通行证的差异。',
    steps: [
      '运行 cdscli auth check，再用 cdscli project show <projectId> 验证目标项目权限',
      '同一 CDS 主机和目标项目都验证通过时直接继续，不要求用户重复认证',
      '缺少目标项目权限时才运行 connect --project <projectId> 并等待页面批准',
      '确需长期跨项目时，引导用户在 CDS 系统设置的 AI Access Key 中明确选择授权范围',
    ],
    checks: [
      '项目级授权可长期复用直到被吊销，不把它误称为一次性登录',
      '全局通行证属于提权，不得由 Agent 自行签发或扩大范围',
      '当前仅支持单项目或所有项目的全局范围，不声称支持多个指定项目组合',
      '任何凭据都不得进入对话、命令输出或日志',
    ],
    completion: [
      '目标项目的只读检查通过',
      '实际权限范围与用户预期一致',
      '本地凭据只保存在当前仓库的 .cds/credentials.json 且不进入 Git',
    ],
    pagePath: () => '/cds-settings#access-keys',
  },
  auth: {
    id: 'auth',
    categoryId: 'access',
    scope: 'system',
    icon: 'auth',
    shortLabel: '登录与 SSO',
    cardDescription: '账号、身份提供方与回调',
    title: '登录与 SSO 认证',
    summary: '识别身份提供方、准备回调与票据配置，用户只处理受保护的密钥输入和明确授权。',
    goal: '检查当前认证状态，按平台无关的一次性票据协议完成账号密码或 SSO 接入，并验证登录闭环。',
    steps: [
      '读取 /api/auth/status 与脱敏后的 /api/auth/sso/config',
      '识别当前认证模式和已登录身份，已生效时不重复修改',
      '需要配置时准备身份提供方、回调地址和默认返回页',
      '保存后完成退出、登录和返回 /project-list 的闭环验证',
    ],
    checks: [
      '客户端密钥和登录密码只允许在受保护的页面输入框或运行环境中处理',
      '不得把密钥复制到对话、命令输出或日志',
      'SSO 登录后默认返回 /project-list，验证完成前不退出当前管理会话',
    ],
    completion: ['认证状态接口返回预期模式', '登录闭环成功', '回调与默认返回页正确'],
    pagePath: () => '/cds-settings#auth',
  },
  github: {
    id: 'github',
    categoryId: 'integrate',
    scope: 'system',
    icon: 'github',
    shortLabel: 'GitHub 接入',
    cardDescription: 'GitHub App、仓库与 Webhook',
    title: 'GitHub 接入',
    summary: '检查 GitHub App、仓库授权与 Webhook 状态，用户只完成平台侧确认。',
    goal: '完成 GitHub App 接入并验证仓库读取、Webhook 和私有仓库授权。',
    steps: [
      '读取 GitHub OAuth、App 和 Webhook 的脱敏状态',
      '核对回调地址、仓库范围和最小权限',
      '完成平台侧授权后验证仓库读取',
      '触发或检查一条 Webhook 记录确认事件链路',
    ],
    checks: ['使用最小仓库权限', '不在对话中传递私钥或 OAuth 密钥', '不把未验证的 Webhook 状态报告为成功'],
    completion: ['目标仓库可读取', 'Webhook 有真实事件记录', '私有仓库授权范围正确'],
    pagePath: () => '/cds-settings#github',
  },
  projects: {
    id: 'projects',
    categoryId: 'integrate',
    scope: 'system',
    icon: 'project',
    shortLabel: '项目总览',
    cardDescription: '识别已有项目和接入入口',
    title: '项目与 Agent 接入',
    summary: '识别仓库、连接已有项目或创建新项目，并把部署推进到可预览状态。',
    goal: '根据当前仓库和 CDS 项目状态完成接入、项目识别、部署与预览验证。',
    steps: [
      '列出 CDS 项目并用仓库远端、项目 ID 和 slug 识别真实目标',
      '优先连接已有项目，只有确认不存在时才创建',
      '检查项目默认分支、仓库绑定和构建配置',
      '部署后调用 preview-url 获取真实入口',
    ],
    checks: ['避免重复创建项目', '所有访问权限都走 CDS 页面批准', '不根据分支名或项目名自行拼预览域名'],
    completion: ['项目身份唯一确定', '项目与仓库绑定正确', '真实预览入口可访问'],
    pagePath: () => '/project-list',
  },
  'system-health': {
    id: 'system-health',
    categoryId: 'inspect',
    scope: 'system',
    icon: 'health',
    shortLabel: 'CDS 健康检查',
    cardDescription: '版本、服务和基础设施状态',
    title: 'CDS 系统健康检查',
    summary: '让 Agent 读取 CDS 版本、运行服务和基础设施状态，先判断故障范围再处理。',
    goal: '区分 CDS 控制面、项目服务和共享基础设施故障，给出有证据的健康结论。',
    steps: [
      '运行 cdscli health、version 与 self status',
      '读取最近服务事件和异常停止记录',
      '核对共享 MongoDB、Redis 与路由状态',
      '按控制面、项目面和基础设施三层给出结论',
    ],
    checks: ['先读状态再执行写操作', '单个项目故障不能误判为 CDS 全局故障', '无法确认时保留未知项并给出下一条检查'],
    completion: ['故障层级已确定', '关键服务状态有证据', '下一步动作与影响范围明确'],
    pagePath: () => '/cds-settings#maintenance',
  },
  'system-observability': {
    id: 'system-observability',
    categoryId: 'inspect',
    scope: 'system',
    icon: 'logs',
    shortLabel: '接口与事件',
    cardDescription: 'HTTP 慢请求、服务事件与错误',
    title: 'CDS 系统接口与事件排查',
    summary: '检查重要接口、慢请求和服务事件，定位超时、鉴权、路由或服务端错误。',
    goal: '围绕用户描述的接口或时间段建立请求、事件和服务状态的证据链。',
    steps: [
      '读取最近 HTTP 日志并按状态码、耗时和路径筛选',
      '读取同一时间窗口的服务事件和容器状态',
      '对重要接口做最小只读复现并记录 trace',
      '将请求失败关联到鉴权、路由、依赖或应用错误',
    ],
    checks: ['日志查询默认脱敏', '不使用破坏性接口做探针', '不能只凭一条日志断言根因'],
    completion: ['异常请求已定位', '关联事件和服务状态一致', '复现或排除步骤可重复'],
    pagePath: () => '/cds-settings#http-logs',
  },
  maintenance: {
    id: 'maintenance',
    categoryId: 'operate',
    scope: 'system',
    icon: 'maintenance',
    shortLabel: '更新与恢复',
    cardDescription: 'CDS Self 更新、重启与恢复',
    title: 'CDS 更新与维护',
    summary: '读取实例状态、准备更新方案，并通过明确授权流程执行高风险操作。',
    goal: '诊断当前实例并完成安全更新、重启或维护验证。',
    steps: [
      '读取当前版本、目标版本和实例健康状态',
      '确认更新来源、影响范围与回滚条件',
      '获得明确授权后执行更新或重启',
      '验证版本、健康状态和公开入口',
    ],
    checks: ['所有运维写操作必须等待页面明确授权', '不在健康未知时连续重启', '保留可追溯的更新与恢复记录'],
    completion: ['目标版本运行', '健康检查通过', '公开入口和核心接口可访问'],
    pagePath: () => '/cds-settings#maintenance',
  },
  settings: {
    id: 'settings',
    categoryId: 'operate',
    scope: 'system',
    icon: 'settings',
    shortLabel: 'CDS 系统设置',
    cardDescription: '系统级规则、变量与运行偏好',
    title: 'CDS 系统设置',
    summary: '理解 CDS 系统设置分区，读取现状并完成最小、安全、可验证的配置变更。',
    goal: '处理 CDS 系统级配置任务，避免让用户学习底层参数。',
    steps: ['定位正确的 CDS 系统设置分区', '读取当前值和来源', '解释影响范围后执行最小变更', '重新读取并验证生效状态'],
    checks: ['不把项目设置混入 CDS 系统设置', '敏感写操作等待页面授权', 'CDS 全局变量与项目环境变量必须明确区分'],
    completion: ['配置保存成功', '运行时读取到新值', '未影响无关项目'],
    pagePath: () => '/cds-settings',
  },
  'project-onboarding': {
    id: 'project-onboarding',
    categoryId: 'integrate',
    scope: 'project',
    icon: 'project',
    shortLabel: '项目接入',
    cardDescription: '扫描仓库并建立 CDS 项目',
    title: '项目扫描与接入',
    summary: '扫描当前代码库、识别技术栈和服务依赖，生成可审阅的 CDS 接入方案。',
    goal: '在不要求用户学习 Compose 和 CDS 参数的前提下，将当前仓库安全接入目标项目。',
    steps: [
      '检查当前仓库、远端和已有 CDS 项目绑定',
      '运行 cdscli scan 与 verify 生成并校验部署结构',
      '列出缺失的项目环境变量和外部依赖',
      '提交接入方案并在批准后部署验证',
    ],
    checks: ['优先复用仓库已有部署结构', '密钥值只存 CDS 项目环境变量', '扫描结果必须经 verify，不直接当作可部署事实'],
    completion: ['项目绑定正确', '部署结构验证通过', '缺失依赖和变量均有明确状态'],
    pagePath: (projectId) => projectPath('/settings', projectId),
  },
  'code-review': {
    id: 'code-review',
    categoryId: 'code',
    scope: 'project',
    icon: 'code',
    shortLabel: '代码检查',
    cardDescription: '部署相关代码、配置与风险',
    title: '项目代码与部署检查',
    summary: '让 Agent 阅读当前代码和部署结构，找出会导致构建、启动、健康检查或安全问题的风险。',
    goal: '结合 CDS 实际运行配置检查代码，不只做静态风格评论，并给出可验证的修复建议。',
    steps: [
      '读取项目技术栈、入口脚本、Dockerfile 和 CDS Compose',
      '对照最近部署记录检查构建与运行假设',
      '检查端口、健康探针、环境变量、依赖和敏感信息边界',
      '按严重度输出问题，并对可安全修复项执行验证',
    ],
    checks: ['不声称已扫描未读取的文件', '代码结论必须关联实际部署路径', '不自动修改密钥或生产配置'],
    completion: ['关键风险有文件或运行证据', '修复建议可执行', '至少一条真实构建或运行路径完成验证'],
    pagePath: (projectId) => projectPath('/settings', projectId),
  },
  branches: {
    id: 'branches',
    categoryId: 'deploy',
    scope: 'project',
    icon: 'branch',
    shortLabel: '分支部署',
    cardDescription: '构建、部署和预览路线',
    title: '分支部署与预览',
    summary: '理解当前项目与分支，完成部署、等待就绪和真实预览验证。',
    goal: '读取当前项目的分支状态和部署记录，完成用户在当前页面要做的部署操作。',
    steps: ['确认当前项目、Git 分支和目标提交', '读取分支状态与最近部署运行', '触发部署并持续等待阶段变化', '就绪后执行 smoke 和 preview-url'],
    checks: ['不跨项目操作', '长任务持续回报阶段与进度', '只使用 CDS API 返回的预览入口'],
    completion: ['目标提交已部署', '服务健康', '真实预览入口可访问'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  'build-diagnostics': {
    id: 'build-diagnostics',
    categoryId: 'deploy',
    scope: 'project',
    icon: 'branch',
    shortLabel: '构建失败',
    cardDescription: '依赖、脚本、镜像与产物',
    title: '构建失败排查',
    summary: '读取真实构建日志和提交差异，定位依赖安装、编译、镜像或产物阶段错误。',
    goal: '找到首个有效构建错误，完成最小修复并用新的部署运行验证。',
    steps: [
      '读取目标分支状态、部署运行和完整构建日志',
      '定位第一个导致退出的错误而不是最后一行噪音',
      '结合目标提交检查依赖、锁文件、构建脚本和镜像阶段',
      '修复后创建新的部署运行并比较结果',
    ],
    checks: ['不把警告当成失败根因', '不在未复现时盲目升级全部依赖', '保留失败运行和修复运行的对应关系'],
    completion: ['首个有效错误已解释', '新构建通过', '修复未引入无关依赖漂移'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  'startup-diagnostics': {
    id: 'startup-diagnostics',
    categoryId: 'deploy',
    scope: 'project',
    icon: 'startup',
    shortLabel: '无法启动',
    cardDescription: '容器退出、探针和依赖服务',
    title: '服务无法启动排查',
    summary: '检查容器退出原因、启动日志、健康探针和依赖服务，不用反复重启掩盖问题。',
    goal: '区分进程退出、探针失败、端口错误和依赖不可用，修复后验证稳定运行。',
    steps: [
      '运行 cdscli diagnose 或 help-me-check 获取分支事实',
      '读取容器退出码、停止原因和启动日志',
      '核对入口命令、监听地址、端口、健康探针和依赖状态',
      '修复后重新部署并观察稳定窗口',
    ],
    checks: ['不连续重启 crash loop', '区分 CDS 计划替换和应用异常退出', '依赖服务故障不能误修应用代码'],
    completion: ['容器持续运行', '健康探针通过', '停止原因和修复形成闭环'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  'log-diagnostics': {
    id: 'log-diagnostics',
    categoryId: 'inspect',
    scope: 'project',
    icon: 'logs',
    shortLabel: '日志排查',
    cardDescription: '构建、容器、HTTP 和事件关联',
    title: '项目日志与异常排查',
    summary: '围绕项目、分支和时间窗口关联构建日志、容器日志、HTTP 日志与服务事件。',
    goal: '从用户现象出发建立时间线，定位最可能的故障层并给出可复现结论。',
    steps: ['确定项目、分支、服务和时间窗口', '分别读取构建、运行、HTTP 与事件记录', '按 trace、状态码和时间关联证据', '使用最小只读请求验证假设'],
    checks: ['默认脱敏日志', '不把不同分支的同名服务混在一起', '没有证据时使用可能性而非确定性措辞'],
    completion: ['异常时间线完整', '根因或排除项有证据', '验证步骤可以重复'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  'api-diagnostics': {
    id: 'api-diagnostics',
    categoryId: 'code',
    scope: 'project',
    icon: 'api',
    shortLabel: '重要接口',
    cardDescription: '鉴权、路由、响应和性能',
    title: '项目重要接口排查',
    summary: '检查关键接口的鉴权、路由、依赖、响应结构和耗时，避免只看页面报错。',
    goal: '用最小、安全的请求复现接口问题，并从代理到应用建立完整调用链。',
    steps: [
      '确认接口方法、路径、预期身份和目标分支',
      '读取同一请求的 HTTP 日志、服务日志和 trace',
      '使用只读或可回滚样本复现状态码与响应',
      '检查路由、鉴权、参数、依赖和超时配置',
    ],
    checks: ['不把写接口当健康探针', '请求和响应中的敏感字段必须脱敏', '区分网关错误和应用错误'],
    completion: ['接口问题可复现或已排除', '错误层级明确', '修复后状态码、响应和耗时符合预期'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  'preview-diagnostics': {
    id: 'preview-diagnostics',
    categoryId: 'deploy',
    scope: 'project',
    icon: 'preview',
    shortLabel: '预览异常',
    cardDescription: '域名、路由、入口和资源',
    title: '预览入口异常排查',
    summary: '检查服务已运行但预览打不开、路由错误、静态资源失败或入口不完整的问题。',
    goal: '只使用 CDS 发布的真实入口，区分容器、代理、路由和前端资源故障。',
    steps: ['运行 preview-url 获取全部真实入口', '检查目标服务和容器端口', '验证入口根路径、健康路径和关键静态资源', '关联代理日志与应用日志定位失败层'],
    checks: ['禁止本地拼接预览域名', '多服务入口必须逐条验证', '容器 running 不等于页面可用'],
    completion: ['真实入口可访问', '关键资源加载成功', '多入口数量与 CDS API 一致'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  'project-settings': {
    id: 'project-settings',
    categoryId: 'integrate',
    scope: 'project',
    icon: 'settings',
    shortLabel: '项目设置',
    cardDescription: '构建配置、路由和项目规则',
    title: '项目设置',
    summary: '读取目标项目的现有配置，自动补齐运行方式、依赖和部署声明。',
    goal: '基于当前项目代码和现有配置给出最小变更，并在保存前解释影响范围。',
    steps: ['读取目标项目当前设置和配置来源', '对照仓库结构识别缺失或漂移', '解释影响后保存最小变更', '重新读取并用部署验证'],
    checks: ['敏感值不进入对话或日志', '不把 CDS 系统设置混入项目设置', '保存后执行配置与运行验证'],
    completion: ['项目设置保存成功', '配置来源明确', '目标分支按新配置运行'],
    pagePath: (projectId) => projectPath('/settings', projectId),
  },
  'service-integration': {
    id: 'service-integration',
    categoryId: 'integrate',
    scope: 'project',
    icon: 'service',
    shortLabel: '服务接入',
    cardDescription: '数据库、缓存和外部依赖',
    title: '项目服务与依赖接入',
    summary: '识别数据库、缓存、消息和外部服务依赖，优先复用 CDS 已有能力。',
    goal: '为目标项目接入真实依赖服务，建立连接、健康和隔离验证。',
    steps: ['扫描代码和部署结构中的依赖声明', '查询 CDS 当前项目可用资源与连接信息', '选择复用、创建或外部接入方案', '部署后验证应用到依赖的真实连接'],
    checks: ['不假定不存在的服务已经提供', '连接信息和密钥不进入对话', '项目级与共享资源作用域必须明确'],
    completion: ['依赖资源状态健康', '应用连接成功', '作用域和生命周期符合预期'],
    pagePath: (projectId) => projectPath('/settings', projectId),
  },
  'env-diagnostics': {
    id: 'env-diagnostics',
    categoryId: 'integrate',
    scope: 'project',
    icon: 'database',
    shortLabel: '项目环境变量',
    cardDescription: '缺失、作用域和运行时生效',
    title: '项目环境变量排查',
    summary: '检查项目环境变量的缺失、占位符、作用域和运行时注入，不让密钥进入仓库。',
    goal: '确定应用需要的键、CDS 已保存的键和运行时实际获得的键之间的差异。',
    steps: ['从代码和部署结构提取所需变量名', '读取 CDS 项目环境变量的脱敏键列表', '识别缺失、占位符和作用域错误', '补齐后重新部署并验证运行时状态'],
    checks: ['只显示变量名和脱敏状态', '真实值只在 CDS 受保护范围输入', 'CDS 全局变量不能替代应隔离的项目值'],
    completion: ['必需变量均存在', '作用域正确', '应用启动和核心接口验证通过'],
    pagePath: (projectId) => projectPath('/settings', projectId),
  },
  release: {
    id: 'release',
    categoryId: 'deliver',
    scope: 'project',
    icon: 'release',
    shortLabel: '正式发布',
    cardDescription: '预检、执行、入口和回滚',
    title: '正式发布',
    summary: '检查发布目标、版本与回滚条件，按可追溯流程完成发布。',
    goal: '完成当前项目的发布预检、执行、入口验证与回滚准备。',
    steps: ['确认目标环境、提交和不可变构建产物', '检查域名、证书、变量和回滚点', '获得明确授权后执行发布', '从公网入口验证页面和核心接口'],
    checks: ['不把预览部署当正式发布', '复用可追溯构建产物', '发布写操作必须明确授权'],
    completion: ['最终公开入口可访问', '版本与目标提交一致', '回滚路径可用'],
    pagePath: () => '/release-center',
  },
  rollback: {
    id: 'rollback',
    categoryId: 'operate',
    scope: 'project',
    icon: 'rollback',
    shortLabel: '版本回滚',
    cardDescription: '选择历史版本并恢复服务',
    title: '部署版本回滚',
    summary: '比较当前故障版本与可复用历史版本，在明确授权后执行可追溯回滚。',
    goal: '用最短恢复路径让目标分支重新可用，并保留故障版本证据。',
    steps: ['读取当前部署版本和最近可用历史版本', '比较提交、配置和运行模式差异', '获得明确授权后执行 rollback', '验证健康状态、接口和预览入口'],
    checks: ['不删除故障证据', '回滚前确认目标分支和版本', '回滚成功后仍需记录后续修复项'],
    completion: ['目标历史版本运行', '服务和入口恢复', '故障版本与后续修复已记录'],
    pagePath: (projectId) => projectPath('/branches', projectId),
  },
  tasks: {
    id: 'tasks',
    categoryId: 'operate',
    scope: 'project',
    icon: 'schedule',
    shortLabel: '任务调度',
    cardDescription: '定时任务、触发和运行记录',
    title: '任务调度',
    summary: '创建或诊断定时任务，并根据运行记录验证真实执行结果。',
    goal: '完成当前调度任务的配置、触发与结果验证。',
    steps: ['检查时区、调度表达式和目标项目', '测试动作安全性和重复执行风险', '保存后手动触发一轮', '读取运行记录和真实输出'],
    checks: ['手动触发前说明影响', '避免重复创建同一任务', '不以配置保存代替执行验收'],
    completion: ['任务按预期触发', '运行记录成功', '输出结果可验证'],
    pagePath: () => '/task-schedule',
  },
  reports: {
    id: 'reports',
    categoryId: 'deliver',
    scope: 'project',
    icon: 'check',
    shortLabel: '验收报告',
    cardDescription: '步骤、证据和结果归档',
    title: '验收报告',
    summary: '查找、整理或生成可追溯的验收证据。',
    goal: '围绕当前功能完成报告查询、证据整理与结果交付。',
    steps: ['确认验收目标、版本和入口', '按真实用户路径执行步骤', '收集结果、日志和截图证据', '创建报告并返回可访问入口'],
    checks: ['保留目标、步骤、结果和证据', '不伪造未执行的验收结论', '敏感信息进入报告前先脱敏'],
    completion: ['报告包含完整证据链', '结论与实际结果一致', '报告入口可访问'],
    pagePath: () => '/reports',
  },
  general: {
    id: 'general',
    categoryId: 'inspect',
    scope: 'project',
    icon: 'health',
    shortLabel: '当前页面',
    cardDescription: '先理解上下文再操作',
    title: '当前 CDS 页面',
    summary: '把当前页面、目标和安全边界一起交给 Agent，让它先理解上下文再操作。',
    goal: '识别当前页面可用能力，完成用户目标并提供可验证结果。',
    steps: ['识别当前页面、项目和分支', '读取页面对应的只读状态', '说明计划与权限边界', '执行后返回可验证结果'],
    checks: ['不猜测项目、分支或环境', '敏感信息不进入对话或日志', '写操作遵循页面授权与最小权限'],
    completion: ['目标上下文明确', '操作结果已验证', '未越过项目和权限边界'],
    pagePath: () => '/',
  },
};

export const SYSTEM_AGENT_CONTEXT_IDS: AgentPageContextId[] = Object.values(AGENT_MISSION_DEFINITIONS)
  .filter((definition) => definition.scope === 'system')
  .map((definition) => definition.id);

export const PROJECT_AGENT_CONTEXT_IDS: AgentPageContextId[] = Object.values(AGENT_MISSION_DEFINITIONS)
  .filter((definition) => definition.scope === 'project')
  .map((definition) => definition.id);

export function getAgentMissionDefinition(contextId: AgentPageContextId): AgentMissionDefinition {
  return AGENT_MISSION_DEFINITIONS[contextId];
}

export function getAgentMissionCategoryDefinition(
  categoryId: AgentMissionCategoryId,
): AgentMissionCategoryDefinition {
  return AGENT_MISSION_CATEGORY_DEFINITIONS.find((category) => category.id === categoryId)
    || AGENT_MISSION_CATEGORY_DEFINITIONS[0];
}

export function getAgentMissionsForScope(scope: AgentMissionScope): AgentMissionDefinition[] {
  return Object.values(AGENT_MISSION_DEFINITIONS).filter((definition) => definition.scope === scope);
}

export function getAgentMissionCategoriesForScope(scope: AgentMissionScope): AgentMissionCategoryDefinition[] {
  const categoryIds = new Set(getAgentMissionsForScope(scope).map((definition) => definition.categoryId));
  return AGENT_MISSION_CATEGORY_DEFINITIONS.filter((category) => categoryIds.has(category.id));
}

export function getAgentMissionsForCategory(
  scope: AgentMissionScope,
  categoryId: AgentMissionCategoryId,
): AgentMissionDefinition[] {
  return getAgentMissionsForScope(scope).filter((definition) => definition.categoryId === categoryId);
}

export function createRegisteredAgentContext(
  contextId: AgentPageContextId,
  projectId?: string,
  pagePathOverride?: string,
): AgentPageContext {
  const definition = getAgentMissionDefinition(contextId);
  return {
    ...definition,
    pagePath: pagePathOverride || definition.pagePath(projectId),
  };
}
