import { CODE_REVIEW_MCP_TOOLS } from './code-review.js';

type AgentMissionScope = 'system' | 'project';

export type CdsCapabilityRisk = 'read-only' | 'write' | 'destructive' | 'protocol';
export type CdsCapabilityAccess = 'public' | 'project' | 'system' | 'human-only' | 'protocol-token';
export type CdsMcpExposure = 'read-only-candidate' | 'approval-required' | 'not-exposed' | 'available';

export interface CdsAgentSkillDefinition {
  id: 'cds' | 'cds-project-scan' | 'cds-deploy-pipeline' | 'cds-release' | 'preview-url';
  label: string;
  role: string;
  required: boolean;
}

export interface CdsAgentCapabilityDefinition {
  id: string;
  label: string;
  routeSource: string;
  scope: AgentMissionScope | 'mixed';
  access: CdsCapabilityAccess;
  risk: CdsCapabilityRisk;
  agentUse: 'direct' | 'guided' | 'protocol-only' | 'internal-only';
  preferredSkill: CdsAgentSkillDefinition['id'];
  cliFamily?: string;
  mcpExposure: CdsMcpExposure;
  mcpTools?: readonly string[];
  note: string;
}

export const CDS_AGENT_SKILL_DEFINITIONS: readonly CdsAgentSkillDefinition[] = [
  { id: 'cds', label: 'CDS 核心技能', role: '认证、能力分诊、环境变量、系统维护和共享 CLI', required: true },
  { id: 'cds-project-scan', label: '项目扫描技能', role: '扫描仓库、生成和校验 Compose、提交项目接入', required: true },
  { id: 'cds-deploy-pipeline', label: '部署排障技能', role: '部署、日志、诊断、冒烟和灰度状态', required: true },
  { id: 'cds-release', label: '正式发布技能', role: '生产目标发现、预检、发布、回滚和证据归档', required: true },
  { id: 'preview-url', label: '真实预览地址技能', role: '只读取 CDS API 已发布的公开入口', required: true },
] as const;

type CapabilitySeed = readonly [
  id: string,
  label: string,
  routeSource: string,
  scope: CdsAgentCapabilityDefinition['scope'],
  access: CdsCapabilityAccess,
  risk: CdsCapabilityRisk,
  agentUse: CdsAgentCapabilityDefinition['agentUse'],
  preferredSkill: CdsAgentSkillDefinition['id'],
  cliFamily: string,
  note: string,
];

const CDS_AGENT_CAPABILITY_SEEDS = [
  ['code-reviews', '代码审查任务与报告上传', 'code-reviews.ts', 'project', 'project', 'write', 'direct', 'cds', 'code-review', 'ZIP/GitHub 固定快照；本地 stdio MCP 复用项目权限；报告按内容去重，邮件由提交者选择'],
  ['identity-connections', '原账号设备接入与恢复', 'identity-connections.ts', 'mixed', 'public', 'write', 'direct', 'cds', 'connect --recover', '匿名只能提交仓库恢复申请；原账号与原项目由系统所有者核对，历史匿名凭据归属也必须明确人工确认'],
  ['access-requests', 'Agent 项目授权申请', 'access-requests.ts', 'mixed', 'public', 'write', 'direct', 'cds', 'connect', '发起申请可免密，批准和拒绝必须由人类页面完成'],
  ['auth-local', '本地账号与用户管理', 'auth-local.ts', 'system', 'human-only', 'write', 'guided', 'cds', '', '密码和用户管理不得经对话或普通 Agent 工具传递'],
  ['user-project-access', '人类账号项目授权', 'user-project-access.ts', 'system', 'human-only', 'write', 'guided', 'cds', '', '仅系统所有者通过用户管理页分配和撤销项目访问，不允许普通用户或 Agent 自行提权'],
  ['auth-session', '会话与 GitHub 登录', 'auth.ts', 'system', 'human-only', 'protocol', 'protocol-only', 'cds', '', 'OAuth 回调和浏览器会话不是普通 Agent 工具'],
  ['branches', '分支、构建、资源与数据工作台', 'branches.ts', 'project', 'project', 'write', 'direct', 'cds-deploy-pipeline', 'branch', '写查询、恢复、清空和删除资源必须单独升级为破坏性审批'],
  ['preview-address', '分支地址、项目 slug 与独立子域', 'preview-address.ts', 'project', 'human-only', 'write', 'guided', 'preview-url', '', '仅已认证且有项目访问权的人类可查看，保存与验证仅系统所有者；唯一性校验、版本锁和审计由服务端执行，Agent 不得伪造会话或修改他人项目'],
  ['instance-catalog', '主备 CDS 实例目录', 'instance-catalog.ts', 'mixed', 'project', 'read-only', 'direct', 'cds', 'instance', '只读公共地址；实例独立授权，切换不迁移数据库或接管流量'],
  ['bootstrap', '项目初始化与技能分发', 'bootstrap.ts', 'system', 'public', 'read-only', 'direct', 'cds', '', '匿名只读：发引导脚本与代理 MAP 技能包，不签发凭据也不碰项目数据'],
  ['bug-reports', '快捷提 bug 与缺陷转发', 'bug-reports.ts', 'system', 'system', 'write', 'direct', 'cds', '', '缺陷系统凭据只在服务端读取；未配置转发时只做本地留存，不得声称已同步'],
  ['bridge', '页面 Bridge 与导航握手', 'bridge.ts', 'project', 'protocol-token', 'protocol', 'protocol-only', 'cds', '', '使用 Bridge 会话令牌和页面批准，不作为万能浏览器控制接口'],
  ['cache', '缓存状态、导入导出与修复', 'cache.ts', 'system', 'system', 'destructive', 'guided', 'cds', '', 'repair、import 和 purge 需要快照、影响说明和人工批准'],
  ['cds-events', 'CDS 事件与自刷新', 'cds-events.ts', 'system', 'system', 'write', 'direct', 'cds', '', '事件可只读查询，自刷新属于写操作'],
  ['cds-system-connections', 'CDS 系统间连接', 'cds-system-connections.ts', 'system', 'protocol-token', 'protocol', 'protocol-only', 'cds', '', '连接签发、接受和撤销走专用长令牌协议'],
  ['cds-system-topology', 'CDS 网络拓扑', 'cds-system-topology.ts', 'system', 'system', 'read-only', 'direct', 'cds', '', '只读拓扑用于判断控制面、节点和路由故障范围'],
  ['cds-system-diagnostics', 'CDS 主线程诊断', 'cds-system-diagnostics.ts', 'system', 'system', 'read-only', 'direct', 'cds', '', '只读观测主线程被卡时间、分段耗时、卡顿归因与 SSE 长连接；CPU 采样会给主线程加少量开销，同一时刻只允许一次'],
  ['cds-system-offsite-backup', 'CDS 离机备份配置', 'cds-system-offsite-backup.ts', 'system', 'system', 'write', 'guided', 'cds', '', '凭据先对 R2 实测再落盘，通不过一律不保存；读取永不返回 secret，access key 只回尾四位'],
  ['cds-system-sealed-storage', 'CDS 密封存储初始化', 'cds-system-sealed-storage.ts', 'system', 'human-only', 'destructive', 'guided', 'cds', '', '只允许全局人工管理员同源初始化；服务端生成密钥且永不接受或回显客户端密钥材料'],
  ['credential-self-check', '凭据自检', 'credential-self-check.ts', 'system', 'public', 'read-only', 'direct', 'cds', 'connect', '匿名只读诊断：把「未授权」拆成有效 / 已吊销 / 从未签发 / 项目前缀不符；不返回明文或哈希，也不签发任何凭据'],
  ['identity', '身份、用户级凭证与项目授权', 'identity.ts', 'system', 'system', 'write', 'guided', 'cds', 'connect', '用户级凭证只能建项目/列项目/为已授权项目签钥，可达路由一处收口；签发、撤销与授权变更留痕，撤源头级联撤下游'],
  ['cluster', '集群与 Build Gate', 'cluster.ts', 'system', 'protocol-token', 'destructive', 'guided', 'cds', '', 'join、leave 和调度策略变更必须由系统管理员确认'],
  ['comment-template', 'PR 评论模板', 'comment-template.ts', 'mixed', 'system', 'write', 'direct', 'cds', '', '预览后再保存，项目模板和系统模板不能混用'],
  ['deployment-runs', '部署运行与结构化诊断', 'deployment-runs.ts', 'project', 'project', 'read-only', 'direct', 'cds-deploy-pipeline', 'deployment-run', 'SSE 诊断需要持续反馈并保留终态证据'],
  ['deployment-versions', '不可变部署版本与回滚', 'deployment-versions.ts', 'project', 'project', 'destructive', 'direct', 'cds-deploy-pipeline', 'deployment-version', '部署历史版本前必须锁定完整版本和目标分支'],
  ['docker-network-health', 'Docker 网络健康', 'docker-network-health.ts', 'system', 'system', 'read-only', 'direct', 'cds', '', '用于网络故障证据，不自动执行网络重建'],
  ['github-oauth', 'GitHub OAuth 与仓库发现', 'github-oauth.ts', 'system', 'human-only', 'protocol', 'protocol-only', 'cds', '', '设备授权由用户在 GitHub 完成，Agent 只轮询脱敏状态'],
  ['github-webhook', 'GitHub App、仓库绑定与 Webhook', 'github-webhook.ts', 'mixed', 'system', 'write', 'guided', 'cds', '', 'Webhook 回调由 HMAC 鉴权，不作为普通调用工具'],
  ['infra-backup', '基础设施备份与恢复', 'infra-backup.ts', 'project', 'project', 'destructive', 'guided', 'cds', '', '恢复前必须确认备份、目标资源、影响范围和回滚点'],
  ['infra-credential-rotation', '基础设施凭据轮换', 'infra-credential-rotation.ts', 'project', 'project', 'destructive', 'guided', 'cds', '', '仅在密封存储就绪、维护作业排空并完成可恢复备份后轮换；必须验证旧凭据撤销和业务就绪'],
  ['infra-data', '基础设施数据与 Schema', 'infra-data.ts', 'project', 'project', 'write', 'guided', 'cds', '', '查询默认只读，初始化 SQL 和写查询需要额外批准'],
  ['legacy-cleanup', '遗留数据清理', 'legacy-cleanup.ts', 'system', 'human-only', 'destructive', 'guided', 'cds', '', '只允许先查看状态，再由人类明确批准清理或重命名'],
  ['managed-projects', '托管项目目录', 'managed-projects.ts', 'system', 'system', 'write', 'direct', 'cds', '', '托管目录和普通项目身份需要分别核对'],
  ['notices', '服务端站内信账本', 'notices.ts', 'mixed', 'system', 'write', 'direct', 'cds', '', '账本记录发布失败、生产掉线等告警；外发未配置时状态是「未外发」，不得当作已通知到人'],
  ['operator-console', '系统运维审批台', 'operator-console.ts', 'system', 'human-only', 'destructive', 'guided', 'cds', '', 'AI 可以发起请求和查状态，批准、拒绝和执行仅人类可做'],
  ['peer-sync', 'Peer Sync 配对与资源同步', 'peer-sync.ts', 'system', 'protocol-token', 'destructive', 'protocol-only', 'cds', 'peer', '配对码、HMAC 和资源 apply 属于专用同步协议'],
  ['pending-import', '项目配置导入审批', 'pending-import.ts', 'project', 'project', 'write', 'direct', 'cds-project-scan', 'import', 'Agent 可提交，审批和拒绝由页面完成'],
  ['project-compose', 'Compose 与配置漂移', 'project-compose.ts', 'project', 'project', 'write', 'direct', 'cds-project-scan', 'scan / verify', '变更 Compose 前先读取当前 SSOT 并执行 drift scan'],
  ['project-infra-resync', '基础设施重新同步', 'project-infra-resync.ts', 'project', 'project', 'destructive', 'guided', 'cds-project-scan', '', '必须先 preview，再批准 execute'],
  ['project-migration', '项目与数据迁移', 'project-migration.ts', 'project', 'project', 'destructive', 'guided', 'cds', '', '迁移需要来源、目标、快照、进度和可回滚证据'],
  ['db-ledger', '数据台账：派生库备份、演练、丢弃、时间点克隆与回写', 'db-ledger.ts', 'project', 'project', 'destructive', 'guided', 'cds', '', '一本血缘台账：查看、扫描补录、预览回写可直接执行；丢弃派生库必须先有演练验证过的备份或用户复述库名强制；回写 / 回退会整库覆盖源库，必须用户复述目标库名，系统先自动备份并演练——不许绕过门禁'],
  ['db-probe', '分支数据库实测', 'db-probe.ts', 'project', 'project', 'read-only', 'direct', 'cds', '', '只读：配置说的 / 容器持有 / 连上的库三列并排，回答「这个分支现在真的连着哪个库」；判定 mismatch 时先看原因再决定重新部署'],
  ['project-db-isolation', '项目数据库隔离', 'project-db-isolation.ts', 'project', 'project', 'write', 'direct', 'cds', '', '改的是项目默认（BuildProfile.dbScope），先全量校验再一次落盘；分支覆盖不受影响，重新部署后才生效'],
  ['project-storage', '项目存储占用', 'project-storage.ts', 'project', 'project', 'read-only', 'direct', 'cds', '', '只读容量检查可直接执行，清理必须转入对应破坏性能力'],
  ['projects', '项目、环境变量与 Agent Key', 'projects.ts', 'mixed', 'project', 'write', 'direct', 'cds', 'project / env / key', '所有命令都必须锁定项目 ID，机器凭据不得自行提权'],
  ['releases', '正式发布控制面', 'releases.ts', 'project', 'project', 'destructive', 'direct', 'cds-release', '', '发现、预检、发布、验证、回滚和归档必须形成完整证据链'],
  ['replica-sets', '复制集成员、隔离库与执行计划', 'replica-sets.ts', 'project', 'project', 'destructive', 'direct', 'cds-deploy-pipeline', '', '加副本/调权重可逆；解散、隔离库、回切涉及数据库克隆与容器拆除，执行前必须锁定分支与服务'],
  ['remote-hosts', '远程主机、Sidecar 与 Agent 会话', 'remote-hosts.ts', 'mixed', 'system', 'destructive', 'guided', 'cds', '', '主机密钥、工具审批和会话停止需要人类边界'],
  ['reports', '报告、资产、分享与 PR 回写', 'reports.ts', 'mixed', 'project', 'write', 'direct', 'cds', 'report / report-folder', '分享和推送 PR 前检查脱敏与目标项目'],
  ['scheduled-jobs', '定时任务与运行记录', 'scheduled-jobs.ts', 'project', 'project', 'write', 'direct', 'cds', 'schedule', '先 parse 和 test，默认不直接创建或执行危险命令'],
  ['snapshots', '配置快照、回滚与撤销', 'snapshots.ts', 'system', 'system', 'destructive', 'guided', 'cds', '', '破坏性操作前建立快照，优先使用 undo 而不是再次修改'],
  ['storage-mode', '状态存储模式切换', 'storage-mode.ts', 'system', 'human-only', 'destructive', 'guided', 'cds', '', '切换前必须预检后端、迁移路径和回滚策略'],
  ['ticket-sso', '平台无关票据 SSO', 'ticket-sso.ts', 'system', 'human-only', 'protocol', 'guided', 'cds', '', '保留当前管理员会话，在隔离会话完成登录验证'],
  ['topology', '服务关系图、拓扑体检与引用切换', 'topology.ts', 'project', 'project', 'write', 'direct', 'cds', 'verify / topology', '体检与读图只读；切换引用（PUT references）会写该服务的分支覆盖并要求重新部署，所以整组按写能力对待；修正 compose 仍回写仓库根再导入'],
  ['alarm-channels', '通知通道：哪些出问题通知谁（Bark / Webhook / MAP）', 'alarm-channels.ts', 'system', 'human-only', 'write', 'guided', 'cds', 'monitor', '通道是系统级的，项目级 Key 一律 403；密钥只写不读（读接口只回名字、末四位与指纹）；「演练」会真的往外发一条通知，不是干跑'],
  ['uptime', '监控中心：存活探测、故障时间线与自定义监控', 'uptime.ts', 'mixed', 'system', 'write', 'direct', 'cds', 'monitor', '探测结果只读，可用率与故障判定以探测器采样为准；自定义监控的增删改与「立即探测」是写操作，项目级 Key 只能改自己项目的目标，不代表可直接重启服务'],
  ['project-inspections', '项目巡检：逐项实测结果与通知回执', 'project-inspections.ts', 'project', 'project', 'write', 'direct', 'cds', '', '仅回填自己项目的实测事实，不创建新调度，不改变通知通道；不能把回填声明当作独立探测或手机已读证明'],
  ['public-status', '公开状态页：匿名只读面板与项目侧开关', 'public-status.ts', 'project', 'project', 'write', 'guided', 'cds', 'monitor', '读取那条是匿名的（token 自鉴权），载荷由白名单构造，只出业务名与红黄绿；开关是写操作且对外可见——开公开页等于把这几条业务的红绿交给任何拿到链接的人，必须由人确认'],
  ['workspaces', '工作区、成员与邀请', 'workspaces.ts', 'system', 'human-only', 'write', 'guided', 'cds', '', '成员角色和邀请变更必须由工作区管理员确认'],
  ['server-control-plane', '健康、观测、AI 配对与系统状态', 'server.ts', 'mixed', 'system', 'write', 'direct', 'cds', 'health / auth / self', '公开探针只读，AI 批准和系统写操作保持人类边界'],
  ['executor-scheduler', 'Executor 注册、容量与调度', 'scheduler/routes.ts', 'system', 'protocol-token', 'destructive', 'internal-only', 'cds', '', '永久 Executor Token 专用，不向普通项目 Agent 暴露'],
  ['executor-agent', 'Executor 部署代理接口', 'executor/routes.ts', 'system', 'protocol-token', 'destructive', 'internal-only', 'cds-deploy-pipeline', '', '仅供 CDS 调度器与执行节点通信'],
] as const satisfies readonly CapabilitySeed[];

function deriveMcpExposure(
  risk: CdsCapabilityRisk,
  agentUse: CdsAgentCapabilityDefinition['agentUse'],
): CdsMcpExposure {
  if (agentUse === 'protocol-only' || agentUse === 'internal-only' || risk === 'protocol') {
    return 'not-exposed';
  }
  if (risk === 'read-only' && agentUse === 'direct') {
    return 'read-only-candidate';
  }
  return 'approval-required';
}

export const CDS_AGENT_CAPABILITY_DEFINITIONS: readonly CdsAgentCapabilityDefinition[] =
  CDS_AGENT_CAPABILITY_SEEDS.map(([
    id,
    label,
    routeSource,
    scope,
    access,
    risk,
    agentUse,
    preferredSkill,
    cliFamily,
    note,
  ]) => ({
    id,
    label,
    routeSource,
    scope,
    access,
    risk,
    agentUse,
    preferredSkill,
    ...(cliFamily ? { cliFamily } : {}),
    mcpExposure: id === 'code-reviews' ? 'available' : deriveMcpExposure(risk, agentUse),
    ...(id === 'code-reviews' ? { mcpTools: CODE_REVIEW_MCP_TOOLS } : {}),
    note,
  }));

