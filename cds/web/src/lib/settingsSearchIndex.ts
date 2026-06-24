/*
 * settingsSearchIndex — Spotlight 式「设置 / 配置 / 资源」搜索索引（SSOT）。
 *
 * 背景（2026-06-24 用户反馈）：Cmd/Ctrl+K 命令面板原本只能搜「项目 / 分支 /
 * 设置 tab 名」，搜不到 tab *里面* 的具体配置项。用户想搜「30 分钟剔除保活」
 * （= 调度器·空闲自动下线时长）和「探活 240s」（= 项目配置·就绪探测超时）都
 * 落空。要做到苹果聚焦那样「任何配置、资源、设置都能搜」，必须把字段级配置
 * 逐条登记，并给每条配上丰富的同义词（中文口语 + 英文 + 数值），子串模糊匹配
 * 才能命中用户脑子里那个词。
 *
 * 维护规则：在 CdsSettings / ProjectSettings 任一 tab 里新增一个用户会去搜的
 * 配置字段时，必须在这里补一条 entry，keywords 覆盖它的中文正式名 + 口语别名
 * + 英文字段名。tab 值必须等于目标页面 TabValue（用于 #hash 深链）。
 */

export type SettingsScope = 'system' | 'project';

export interface SettingsIndexEntry {
  /** 稳定 id，用于 React key + 去重 */
  id: string;
  /** 展示名（命令面板里那行主标题） */
  label: string;
  /** 副标题：说明它在哪、是干嘛的 */
  hint: string;
  /** 目标 tab 的 hash 值（CdsSettings/ProjectSettings 的 TabValue） */
  tab: string;
  /** 系统级（/cds-settings）还是项目级（/settings/:projectId） */
  scope: SettingsScope;
  /**
   * 同义词 / 别名表。子串匹配命中即算。务必覆盖：
   *  - 中文正式名（空闲自动下线）
   *  - 中文口语别名（保活、剔除、降温）
   *  - 英文字段名（idleTTL、readiness）
   *  - 相关数值（240、30 分钟）
   */
  keywords: string[];
}

/*
 * tab 值 → 人类可读的分区名。用于在命令面板里拼出完整面包屑路径
 * （如「CDS 系统设置 / 调度器」），让用户搜到配置的同时记住它在哪。
 * 与 CdsSettingsPage / ProjectSettingsPage 的 tab label 保持一致。
 */
export const SYSTEM_TAB_LABELS: Record<string, string> = {
  maintenance: '更新与重启',
  'access-keys': 'AI Access Key',
  overview: '概览',
  auth: '登录与认证',
  users: '用户管理',
  activity: '用户痕迹',
  github: 'GitHub 集成',
  'github-whitelist': 'GitHub 白名单',
  'webhook-log': 'Webhook 日志',
  storage: '存储后端',
  scheduler: '调度器',
  cluster: '集群',
  'remote-hosts': '远程主机',
  connections: '对接 MAP',
  'global-vars': 'CDS 全局变量',
  'loading-pages': '加载页预览',
  snapshots: '配置快照',
};

export const PROJECT_TAB_LABELS: Record<string, string> = {
  general: '基础信息',
  github: 'GitHub',
  'comment-template': '评论模板',
  env: '项目环境变量',
  'runtime-defaults': '新分支默认',
  compose: '项目配置',
  infra: '基础设施',
  storage: '存储',
  migration: '迁移',
  cache: '缓存诊断',
  stats: '统计',
  activity: '活动日志',
  danger: '删除项目',
};

/*
 * 系统级设置（/cds-settings#<tab>）。tab 取值见
 * CdsSettingsPage.tsx 的 TabValue。
 */
export const SYSTEM_SETTINGS_INDEX: SettingsIndexEntry[] = [
  // —— 调度器（运行时策略）——
  {
    id: 'sys:scheduler:idle-ttl',
    label: '空闲自动下线时长',
    hint: '调度器 · 分支闲置多久后剔除保活、停止变灰',
    tab: 'scheduler',
    scope: 'system',
    keywords: [
      '保活', '剔除保活', '剔除', '空闲', '闲置', '空闲下线', '自动下线', '下线',
      '冷却', '降温', '回收', '自动停止', '停止分支', '空闲超时', '空闲时长',
      '30分钟', '30 分钟', '分钟', 'idle', 'idlettl', 'idle ttl', 'ttl',
      'keepalive', 'keep-alive', 'lru', 'reap', '调度器',
    ],
  },
  {
    id: 'sys:scheduler:enabled',
    label: '启用调度器',
    hint: '调度器 · 开关分支自动降温',
    tab: 'scheduler',
    scope: 'system',
    keywords: ['调度器', 'scheduler', '启用调度', '自动降温', '开关调度'],
  },
  {
    id: 'sys:scheduler:max-hot',
    label: '最大热分支数',
    hint: '调度器 · 同时保活的分支上限，超出按 LRU 驱逐',
    tab: 'scheduler',
    scope: 'system',
    keywords: ['热分支', '最大热分支', '分支上限', '保活上限', 'hot', 'lru', '驱逐', 'max hot', '并发分支'],
  },
  {
    id: 'sys:scheduler:janitor-enabled',
    label: '启用全局过期删除',
    hint: '调度器 · janitor 自动删除过期 worktree / 容器',
    tab: 'scheduler',
    scope: 'system',
    keywords: ['过期删除', 'janitor', '清理', '回收', '磁盘', '自动删除', '过期', 'sweep', '垃圾回收'],
  },
  {
    id: 'sys:scheduler:expiry-days',
    label: '全局过期删除天数',
    hint: '调度器 · 分支超过多少天未用即被删除（最长 7 天）',
    tab: 'scheduler',
    scope: 'system',
    keywords: ['过期天数', '保留天数', '删除天数', 'worktree ttl', 'worktreettl', '天数', '7天', '保留'],
  },
  {
    id: 'sys:scheduler:pinned',
    label: '固定分支（永不冷却）',
    hint: '调度器 · 被固定的分支不参与剔除保活',
    tab: 'scheduler',
    scope: 'system',
    keywords: ['固定分支', '固定', 'pin', 'pinned', '永不冷却', '永不下线', '常驻分支'],
  },

  // —— 更新与重启（维护）——
  {
    id: 'sys:maintenance:self-update',
    label: 'CDS 更新与重启',
    hint: '维护 · self-update / 拉取最新源码并重启',
    tab: 'maintenance',
    scope: 'system',
    keywords: ['更新', '升级', '自更新', 'self-update', 'selfupdate', '重启', 'restart', '更新并重启', '拉取源码'],
  },
  {
    id: 'sys:maintenance:force-update',
    label: '强制更新',
    hint: '维护 · 跳过校验强制拉取并重启',
    tab: 'maintenance',
    scope: 'system',
    keywords: ['强制更新', '强制', 'force update', 'force', '强更'],
  },
  {
    id: 'sys:maintenance:update-history',
    label: '自更新历史',
    hint: '维护 · 历次 self-update 记录与耗时',
    tab: 'maintenance',
    scope: 'system',
    keywords: ['更新历史', '自更新历史', 'update history', '升级记录', '历史'],
  },

  // —— 存储后端 ——
  {
    id: 'sys:storage:backend',
    label: '存储后端',
    hint: '存储 · JSON / MongoDB 切换与诊断',
    tab: 'storage',
    scope: 'system',
    keywords: ['存储', '存储后端', 'storage', 'mongo', 'mongodb', 'json', '切换存储', '存储模式', '.cds.env'],
  },

  // —— 集群 ——
  {
    id: 'sys:cluster:overview',
    label: '集群',
    hint: '集群 · 节点列表 / 容量 / 加入退出',
    tab: 'cluster',
    scope: 'system',
    keywords: ['集群', 'cluster', '节点', '远端节点', '执行器', 'executor', '加入集群', '退出集群'],
  },
  {
    id: 'sys:cluster:strategy',
    label: '调度策略',
    hint: '集群 · 分支落到哪个执行器的策略',
    tab: 'cluster',
    scope: 'system',
    keywords: ['调度策略', '策略', 'strategy', '负载', '分配策略'],
  },
  {
    id: 'sys:cluster:capacity',
    label: '集群容量',
    hint: '集群 · CPU / 内存 / 已用容量',
    tab: 'cluster',
    scope: 'system',
    keywords: ['容量', 'capacity', 'cpu', '内存', 'memory', '核数', '已用容量', '空闲容量'],
  },

  // —— 登录与认证 ——
  {
    id: 'sys:auth:mode',
    label: '登录与认证',
    hint: '认证 · 登录模式 / basic auth / OAuth',
    tab: 'auth',
    scope: 'system',
    keywords: ['认证', 'auth', '登录', '认证模式', 'basic auth', 'oauth', '密码登录', '退出'],
  },

  // —— 用户管理 ——
  {
    id: 'sys:users:manage',
    label: '用户管理',
    hint: '用户 · 创建本地账号 / 用户列表',
    tab: 'users',
    scope: 'system',
    keywords: ['用户', '用户管理', 'user', '账号', '创建账号', '本地账号', '用户列表'],
  },
  {
    id: 'sys:users:password',
    label: '修改密码',
    hint: '用户 · 修改登录密码',
    tab: 'users',
    scope: 'system',
    keywords: ['密码', '修改密码', 'password', '改密码', '改密'],
  },

  // —— 用户痕迹 ——
  {
    id: 'sys:activity:trace',
    label: '用户操作痕迹',
    hint: '用户痕迹 · 谁在什么时候做了什么',
    tab: 'activity',
    scope: 'system',
    keywords: ['痕迹', '操作痕迹', '操作记录', 'activity', '审计', '用户痕迹'],
  },

  // —— AI Access Key ——
  {
    id: 'sys:access-keys',
    label: 'AI Access Key',
    hint: 'AI 密钥 · 签发 / 撤销全局 Agent Key',
    tab: 'access-keys',
    scope: 'system',
    keywords: ['access key', 'ai access key', '访问密钥', '密钥', 'agent key', 'global agent key', 'sk-', '签发', '吊销', '撤销密钥'],
  },

  // —— GitHub ——
  {
    id: 'sys:github:app',
    label: 'GitHub 集成',
    hint: 'GitHub · App / Device Flow / Webhook 地址',
    tab: 'github',
    scope: 'system',
    keywords: ['github', 'github 集成', 'app', 'device flow', 'webhook 地址', '集成', 'oauth'],
  },
  {
    id: 'sys:github:whitelist',
    label: 'GitHub 白名单',
    hint: 'GitHub · 允许触发的组织白名单',
    tab: 'github-whitelist',
    scope: 'system',
    keywords: ['白名单', 'whitelist', '允许组织', 'github 白名单', '组织白名单'],
  },
  {
    id: 'sys:github:webhook-log',
    label: 'GitHub Webhook 日志',
    hint: 'GitHub · 每次 hook 投递详情与派发结果',
    tab: 'webhook-log',
    scope: 'system',
    keywords: ['webhook', 'webhook 日志', 'hook', 'delivery', '派发', '投递', '部署派发'],
  },

  // —— 对接 MAP ——
  {
    id: 'sys:connections:map',
    label: '对接 MAP',
    hint: '对接 · 配对密钥 / 连接记录管理',
    tab: 'connections',
    scope: 'system',
    keywords: ['对接', '对接 map', 'map', '配对', '连接', 'pairing', '配对密钥', '连接记录'],
  },

  // —— CDS 全局变量 ——
  {
    id: 'sys:global-vars',
    label: 'CDS 全局变量',
    hint: '全局变量 · 所有项目共享的环境变量',
    tab: 'global-vars',
    scope: 'system',
    keywords: ['全局变量', 'cds 全局变量', '环境变量', 'env', 'global', 'customenv', '共享变量'],
  },

  // —— 加载页预览 ——
  {
    id: 'sys:loading-pages',
    label: '加载页预览',
    hint: '加载页 · 容器启动 / 等待页样式预览',
    tab: 'loading-pages',
    scope: 'system',
    keywords: ['加载页', 'loading', '等待页', '预览', '加载页预览', '启动页'],
  },

  // —— 配置快照 ——
  {
    id: 'sys:snapshots',
    label: '配置快照',
    hint: '快照 · 备份 / 回滚配置到任意时间点',
    tab: 'snapshots',
    scope: 'system',
    keywords: ['快照', '配置快照', 'snapshot', '备份', '回滚', 'rollback', '还原配置'],
  },

  // —— 远程主机 ——
  {
    id: 'sys:remote-hosts',
    label: '远程主机',
    hint: '远程主机 · shared-service 部署目标 / SSH',
    tab: 'remote-hosts',
    scope: 'system',
    keywords: ['远程主机', 'remote host', 'ssh', 'sidecar', '部署 sidecar', '部署目标', '主机'],
  },

  // —— 镜像与外观 ——
  {
    id: 'sys:mirror:registry',
    label: '镜像加速',
    hint: '维护 · Docker 镜像加速源',
    tab: 'maintenance',
    scope: 'system',
    keywords: ['镜像', '镜像加速', 'mirror', '加速', 'registry', '镜像源', 'docker mirror'],
  },
  {
    id: 'sys:mirror:tab-name',
    label: '浏览器标签名',
    hint: '维护 · 自定义浏览器标签页标题',
    tab: 'maintenance',
    scope: 'system',
    keywords: ['标签名', '浏览器标签', 'tab name', '标题', 'title', '标签页'],
  },

  // —— 概览 ——
  {
    id: 'sys:overview',
    label: 'CDS 概览',
    hint: '概览 · 存储模式 / 运行模式 / 登录用户',
    tab: 'overview',
    scope: 'system',
    keywords: ['概览', 'overview', '运行模式', '存储模式', '初始化状态', '系统状态'],
  },
];

/*
 * 项目级设置（/settings/<projectId>#<tab>）。tab 取值见
 * ProjectSettingsPage.tsx 的 TabValue。命令面板会对每个已加载项目展开一份。
 */
export const PROJECT_SETTINGS_INDEX: SettingsIndexEntry[] = [
  {
    id: 'proj:compose:readiness',
    label: '就绪探测超时（探活）',
    hint: '项目配置 · 服务端口探活 / readiness 超时（如 240s）',
    tab: 'compose',
    scope: 'project',
    keywords: [
      '探活', '就绪探活', '就绪探测', '就绪超时', '健康检查', '健康检查超时',
      'readiness', 'readiness timeout', 'readiness-timeout', 'health', 'healthcheck',
      '端口探测', 'tcp 探活', 'probe', '超时', '240', '240s', '探测超时', '启动探测',
    ],
  },
  {
    id: 'proj:compose:yaml',
    label: '项目配置（cds-compose）',
    hint: '项目配置 · 服务定义 / 镜像 / 端口 / 标签',
    tab: 'compose',
    scope: 'project',
    keywords: ['项目配置', 'compose', 'cds-compose', 'yaml', '服务定义', '构建配置', 'build profile', '镜像', '端口'],
  },
  {
    id: 'proj:env',
    label: '项目环境变量',
    hint: '项目 · 单项目独占的环境变量',
    tab: 'env',
    scope: 'project',
    keywords: ['项目环境变量', '环境变量', 'env', 'project env', 'customenv', 'key=value', '变量'],
  },
  {
    id: 'proj:runtime-defaults',
    label: '新分支默认运行模式',
    hint: '项目 · 新建分支的默认运行模式模板',
    tab: 'runtime-defaults',
    scope: 'project',
    keywords: ['新分支默认', '运行模式', '默认运行模式', 'runtime', 'runtime defaults', '分支模板', '默认模式'],
  },
  {
    id: 'proj:infra',
    label: '项目基础设施',
    hint: '项目 · Mongo / Redis / Postgres / ES 等依赖',
    tab: 'infra',
    scope: 'project',
    keywords: ['基础设施', 'infra', 'mongo', 'redis', 'postgres', 'elasticsearch', '数据库', '依赖服务', 'infrastructure'],
  },
  {
    id: 'proj:github',
    label: '项目 GitHub 关联',
    hint: '项目 · 仓库绑定 / 事件策略 / 自动部署',
    tab: 'github',
    scope: 'project',
    keywords: ['github', '仓库绑定', '项目仓库', '事件策略', 'push', 'pr', '自动部署', '关联仓库'],
  },
  {
    id: 'proj:comment-template',
    label: '项目 PR 评论模板',
    hint: '项目 · GitHub PR 预览评论模板',
    tab: 'comment-template',
    scope: 'project',
    keywords: ['评论模板', 'comment template', 'pr 评论', 'pr comment', '预览评论'],
  },
  {
    id: 'proj:general',
    label: '项目基础信息',
    hint: '项目 · 名称 / slug / Docker 网络 / Public Base URL',
    tab: 'general',
    scope: 'project',
    keywords: ['基础信息', '项目名', 'slug', 'docker 网络', 'public base url', '项目标识', '项目类型'],
  },
  {
    id: 'proj:storage',
    label: '项目存储',
    hint: '项目 · 存储信息与诊断',
    tab: 'storage',
    scope: 'project',
    keywords: ['项目存储', '存储', 'storage', '数据卷', 'volume'],
  },
  {
    id: 'proj:migration',
    label: '项目迁移',
    hint: '项目 · 跨实例迁移设置',
    tab: 'migration',
    scope: 'project',
    keywords: ['迁移', 'migration', '导出', '导入', '搬迁'],
  },
  {
    id: 'proj:cache',
    label: '缓存诊断',
    hint: '项目 · 构建缓存目录诊断 / 导入缓存包',
    tab: 'cache',
    scope: 'project',
    keywords: ['缓存', 'cache', '缓存诊断', '缓存包', '构建缓存', '缓存根目录'],
  },
  {
    id: 'proj:stats',
    label: '项目统计',
    hint: '项目 · 部署 / 拉取 / 运营汇总',
    tab: 'stats',
    scope: 'project',
    keywords: ['统计', 'stats', '运营汇总', '部署统计', '拉取统计'],
  },
  {
    id: 'proj:activity',
    label: '项目活动日志',
    hint: '项目 · 最近操作与事件',
    tab: 'activity',
    scope: 'project',
    keywords: ['活动日志', 'activity', '操作日志', '事件', '最近活动'],
  },
  {
    id: 'proj:danger',
    label: '删除项目',
    hint: '项目 · 危险区，不可逆删除',
    tab: 'danger',
    scope: 'project',
    keywords: ['删除项目', '危险区', 'danger', '删除', '销毁项目', '移除项目'],
  },
];
