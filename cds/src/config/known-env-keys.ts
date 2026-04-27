/**
 * CDS 内置环境变量字典（Single Source of Truth）。
 *
 * 用途：
 *  1. 启动时识别 .cds.env 中误用的旧名（如 JWT_SECRET、AI_ACCESS_KEY），
 *     发 deprecation warning 引导用户改名。
 *  2. exec_cds.sh migrate-env 子命令读取此清单做交互迁移：
 *     - canonical 名（CDS_*）→ 直接保留写 .cds.env
 *     - legacyAliases 命中 → 提示 rename
 *     - 都不命中（如 GITHUB_PAT、R2_*、ROOT_ACCESS_*）→ 项目级，
 *       输出到 migration-project-env.txt 让用户去 Dashboard 配置
 *
 * 为什么硬编码而不是从代码扫描：
 *  - 字典里的描述/分组要给用户看（迁移脚本会打印），动态扫描拿不到语义
 *  - 启动时不能依赖运行时构造（这一步比 loadConfig 还早）
 *
 * 维护规则：
 *  - 新增 CDS_* 变量时同步追加一条
 *  - 永远不再新增 legacyAliases —— 老的兼容名清完一轮就该砍了
 */
export interface CdsEnvKeyDef {
  /** Canonical 名（CDS_ 前缀） */
  key: string;
  /** 历史无前缀名（兼容期内仍读取，但启动时打 warning） */
  legacyAliases?: string[];
  /** 一句话用途，迁移脚本会打印给用户看 */
  description: string;
  /** 是否密钥（迁移时打印是否要遮蔽） */
  isSecret: boolean;
  /** 分组，仅用于迁移输出排版 */
  group: 'auth' | 'storage' | 'cluster' | 'github' | 'domain' | 'misc';
}

export const KNOWN_CDS_ENV_KEYS: CdsEnvKeyDef[] = [
  // ── auth ──
  { key: 'CDS_USERNAME', description: 'Dashboard 登录用户名', isSecret: false, group: 'auth' },
  { key: 'CDS_PASSWORD', description: 'Dashboard 登录密码', isSecret: true, group: 'auth' },
  { key: 'CDS_AUTH_MODE', description: '认证模式（password / oauth-only）', isSecret: false, group: 'auth' },
  { key: 'CDS_AUTH_BACKEND', description: '认证后端（memory / mongo）', isSecret: false, group: 'auth' },
  { key: 'CDS_AUTH_MONGO_DB', description: 'Auth MongoDB 库名', isSecret: false, group: 'auth' },
  {
    key: 'CDS_JWT_SECRET',
    legacyAliases: ['JWT_SECRET'],
    description: 'CDS Dashboard 自身 JWT 签名密钥（>= 32 字节）',
    isSecret: true,
    group: 'auth',
  },
  {
    key: 'CDS_AI_ACCESS_KEY',
    legacyAliases: ['AI_ACCESS_KEY'],
    description: 'AI Agent 调 CDS API 的静态访问 token（X-AI-Access-Key header）',
    isSecret: true,
    group: 'auth',
  },
  { key: 'CDS_BOOTSTRAP_TOKEN', description: '集群引导一次性 token', isSecret: true, group: 'cluster' },
  { key: 'CDS_BOOTSTRAP_TOKEN_EXPIRES_AT', description: 'bootstrap token 过期时间（ISO 8601）', isSecret: false, group: 'cluster' },
  { key: 'CDS_EXECUTOR_TOKEN', description: '永久 executor 认证 token', isSecret: true, group: 'cluster' },
  { key: 'CDS_SECRET_KEY', description: '状态数据加密密钥（state.json 字段级 sealed value）', isSecret: true, group: 'misc' },

  // ── mode / cluster ──
  { key: 'CDS_MODE', description: '运行模式（standalone / scheduler / executor）', isSecret: false, group: 'cluster' },
  { key: 'CDS_MASTER_URL', description: '主节点 URL（executor 模式）', isSecret: false, group: 'cluster' },
  { key: 'CDS_SCHEDULER_URL', description: '调度节点 URL（兼容名，新部署用 CDS_MASTER_URL）', isSecret: false, group: 'cluster' },
  { key: 'CDS_EXECUTOR_PORT', description: 'Executor API 端口（默认 9901）', isSecret: false, group: 'cluster' },
  { key: 'CDS_EXECUTOR_HOST', description: 'Executor 主机地址', isSecret: false, group: 'cluster' },

  // ── storage ──
  { key: 'CDS_STORAGE_MODE', description: '存储模式（json / mongo / mongo-split / auto）', isSecret: false, group: 'storage' },
  { key: 'CDS_MONGO_URI', description: 'MongoDB 连接串', isSecret: true, group: 'storage' },
  { key: 'CDS_MONGO_DB', description: 'MongoDB 数据库名', isSecret: false, group: 'storage' },
  { key: 'CDS_MONGO_CONTAINER', description: 'MongoDB 容器名（exec_cds.sh 启动前置使用）', isSecret: false, group: 'storage' },
  { key: 'CDS_REPOS_BASE', description: '多项目 git clone 根目录（每项目一个子目录）', isSecret: false, group: 'storage' },
  { key: 'CDS_DOCKER_HOST', description: 'Docker daemon 主机地址（默认本地 socket）', isSecret: false, group: 'storage' },

  // ── domain / routing ──
  { key: 'CDS_ROOT_DOMAINS', legacyAliases: ['ROOT_DOMAINS'], description: '根域名列表（逗号分隔）', isSecret: false, group: 'domain' },
  { key: 'CDS_MAIN_DOMAIN', legacyAliases: ['MAIN_DOMAIN'], description: '主域名', isSecret: false, group: 'domain' },
  { key: 'CDS_DASHBOARD_DOMAIN', legacyAliases: ['DASHBOARD_DOMAIN'], description: 'Dashboard 访问域名', isSecret: false, group: 'domain' },
  { key: 'CDS_PREVIEW_DOMAIN', legacyAliases: ['PREVIEW_DOMAIN'], description: '分支预览域名', isSecret: false, group: 'domain' },
  { key: 'CDS_SWITCH_DOMAIN', legacyAliases: ['SWITCH_DOMAIN'], description: '流量切换域名', isSecret: false, group: 'domain' },
  { key: 'CDS_PUBLIC_BASE_URL', description: '公网访问基础 URL（GitHub check-run details_url 用）', isSecret: false, group: 'domain' },

  // ── github ──
  { key: 'CDS_GITHUB_CLIENT_ID', description: 'CDS Dashboard 登录用 GitHub OAuth App ID', isSecret: false, group: 'github' },
  { key: 'CDS_GITHUB_CLIENT_SECRET', description: 'CDS Dashboard 登录用 GitHub OAuth App Secret', isSecret: true, group: 'github' },
  { key: 'CDS_ALLOWED_ORGS', description: '允许登录的 GitHub 组织（逗号分隔）', isSecret: false, group: 'github' },
  { key: 'CDS_GITHUB_APP_ID', description: 'CDS GitHub App ID（webhook + check-run）', isSecret: false, group: 'github' },
  { key: 'CDS_GITHUB_APP_PRIVATE_KEY', description: 'CDS GitHub App PEM 私钥', isSecret: true, group: 'github' },
  { key: 'CDS_GITHUB_WEBHOOK_SECRET', description: 'CDS GitHub Webhook HMAC 密钥', isSecret: true, group: 'github' },
  { key: 'CDS_GITHUB_APP_SLUG', description: 'CDS GitHub App slug（仅展示）', isSecret: false, group: 'github' },

  // ── misc ──
  { key: 'CDS_ENV_FILE', description: '.cds.env 文件路径覆盖', isSecret: false, group: 'misc' },
  { key: 'CDS_SMOKE_SCRIPT_DIR', description: '冒烟测试脚本目录（默认 ./scripts）', isSecret: false, group: 'misc' },
  { key: 'CDS_CONFIG', description: '配置文件路径覆盖（默认 cds.config.json）', isSecret: false, group: 'misc' },
  { key: 'CDS_HOST', description: '运行时自动注入容器的 host 占位（无需手填）', isSecret: false, group: 'misc' },
];

export type EnvClassification = 'cds-canonical' | 'cds-legacy' | 'unknown';

/**
 * 把变量名分类：是 CDS canonical (CDS_*)，还是 CDS 历史无前缀名 (legacy)，
 * 还是与 CDS 无关（项目级）。
 */
export function classifyEnvKey(key: string): EnvClassification {
  for (const def of KNOWN_CDS_ENV_KEYS) {
    if (def.key === key) return 'cds-canonical';
    if (def.legacyAliases?.includes(key)) return 'cds-legacy';
  }
  return 'unknown';
}

/**
 * 给定一个 legacy 名，返回它应改成的 canonical 名 + 定义。
 * 不命中返回 null。
 */
export function getDeprecatedAliasInfo(key: string): { canonical: string; def: CdsEnvKeyDef } | null {
  for (const def of KNOWN_CDS_ENV_KEYS) {
    if (def.legacyAliases?.includes(key)) {
      return { canonical: def.key, def };
    }
  }
  return null;
}

/**
 * 启动时调用：扫一组环境变量名（通常是从 .cds.env 加载到 process.env 的
 * 那些 key），对每个 legacy 名打 deprecation warning。不警告 unknown
 * 名（PATH、HOME、SHELL 这些根本不是 CDS 关心的）。
 */
export function warnLegacyCdsEnvKeys(loadedKeys: string[], sourceLabel: string): void {
  const legacy: Array<{ from: string; to: string; description: string }> = [];
  for (const key of loadedKeys) {
    const info = getDeprecatedAliasInfo(key);
    if (info) legacy.push({ from: key, to: info.canonical, description: info.def.description });
  }
  if (legacy.length === 0) return;
  console.warn(`[cds-env] 检测到 ${legacy.length} 个旧名 CDS 环境变量（来自 ${sourceLabel}）：`);
  for (const item of legacy) {
    console.warn(`  - ${item.from}  →  应改名为 ${item.to}（${item.description}）`);
  }
  console.warn('[cds-env] 当前仍兼容这些旧名读取，但建议运行：');
  console.warn('[cds-env]   ./exec_cds.sh migrate-env');
  console.warn('[cds-env] 自动迁移到 CDS_ 前缀，并把项目级变量分流到 Dashboard。');
}

/**
 * 读取 CDS 内部用的 AI_ACCESS_KEY（X-AI-Access-Key header 验证用）。
 * 优先 CDS_AI_ACCESS_KEY，fallback 旧名 AI_ACCESS_KEY。
 *
 * 注意：这是 CDS 进程级的「静态钥匙」。Dashboard customEnv 里的同名
 * 字段是另一个层面（用户在 UI 上配的全局 / 项目级），不走这个函数。
 */
export function getCdsAiAccessKey(): string | undefined {
  return process.env.CDS_AI_ACCESS_KEY || process.env.AI_ACCESS_KEY || undefined;
}
