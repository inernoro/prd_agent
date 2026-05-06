/**
 * change-impact-analyzer — 判断 git diff 涉及的改动是否需要重启 CDS 进程。
 *
 * 默认策略:**保守判定**(`needsRestart=true` 是默认),只有所有改动文件都明确
 * 落入"热重载安全"白名单,才返回 `needsRestart=false`。
 *
 * 这个保守取舍是为了避免"看着像热重载场景实际不安全"的情况(比如 import
 * 了新模块、初始化期副作用代码改了、数据库 schema 变更等)— 误判热重载
 * 路径会让旧逻辑继续跑,用户感知到的是"我已经更新但行为没变",debug 极困
 * 难。误判重启路径只是慢一点,可接受。
 *
 * 用户反馈 2026-05-06 让 self-update 同时支持热重载 + 重启,这个模块是
 * 决策入口。
 */

export interface ChangeImpactResult {
  /** true = 必须走完整重启流程;false = 可以走热重载快路径 */
  needsRestart: boolean;
  /** 触发"必须重启"的具体文件 + 原因。为空时 needsRestart 必为 false */
  restartTriggers: Array<{ path: string; reason: string }>;
  /** 即使热重载也建议重新编译的文件(应用代码 .ts/.tsx) */
  hotReloadablePaths: string[];
  /** 完全无影响的文件(纯文档、changelogs) */
  irrelevantPaths: string[];
}

/**
 * 必须重启的硬规则。命中任一即 needsRestart=true。
 * 顺序无关,使用 `some()` 短路。
 */
const RESTART_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 依赖
  { pattern: /(?:^|\/)package\.json$/, reason: '依赖清单变更' },
  { pattern: /(?:^|\/)pnpm-lock\.yaml$/, reason: 'pnpm lockfile 变更' },
  { pattern: /(?:^|\/)package-lock\.json$/, reason: 'npm lockfile 变更' },
  { pattern: /(?:^|\/)yarn\.lock$/, reason: 'yarn lockfile 变更' },
  // 容器/镜像
  { pattern: /(?:^|\/)Dockerfile(\.|$)/, reason: 'Dockerfile 变更需要重建镜像' },
  { pattern: /(?:^|\/)docker-compose[\w.-]*\.ya?ml$/, reason: 'compose 文件变更' },
  { pattern: /(?:^|\/)\.dockerignore$/, reason: 'docker 上下文变更' },
  // 编译/打包配置
  { pattern: /(?:^|\/)tsconfig[\w.-]*\.json$/, reason: 'TypeScript 配置变更' },
  { pattern: /(?:^|\/)vite\.config\.[jt]s$/, reason: 'Vite 配置变更' },
  { pattern: /(?:^|\/)tsup\.config\.[jt]s$/, reason: 'tsup 配置变更' },
  { pattern: /(?:^|\/)esbuild\.config\.[jt]s$/, reason: 'esbuild 配置变更' },
  // 环境变量
  { pattern: /(?:^|\/)\.env(\.[\w-]+)?$/, reason: '环境变量文件变更' },
  { pattern: /(?:^|\/)\.cds\.env$/, reason: 'CDS 环境变量变更' },
  // systemd / 启动脚本
  { pattern: /\.service$/, reason: 'systemd unit 变更' },
  { pattern: /(?:^|\/)exec_cds\.sh$/, reason: 'CDS 启动脚本变更' },
  // CDS 关键路由/初始化代码 — 这些变化即使 hot-reload 也不能正确生效
  // 因为 Express 路由表已挂载,新 router 不会被重新注册
  { pattern: /^cds\/src\/server\.ts$/, reason: 'CDS server bootstrap 变更' },
  { pattern: /^cds\/src\/index\.ts$/, reason: 'CDS 入口变更' },
  { pattern: /^cds\/src\/types\.ts$/, reason: '核心类型 schema 变更' },
  { pattern: /^cds\/src\/config\.ts$/, reason: 'CDS 配置加载逻辑变更' },
  { pattern: /^cds\/src\/load-env\.ts$/, reason: 'env 加载逻辑变更' },
  // 数据库 schema / migration
  { pattern: /(?:^|\/)migrations?\//, reason: '数据库迁移' },
  // 二进制 / native 模块
  { pattern: /\.(?:so|dll|dylib|node)$/, reason: 'native 模块变更' },
];

/**
 * 完全无影响的文件(纯文档/元数据)。命中即 irrelevantPaths,
 * 不参与任何判定。
 */
const IRRELEVANT_PATTERNS: RegExp[] = [
  /\.md$/i,
  /\.txt$/i,
  /(?:^|\/)CHANGELOG[\w.-]*$/,
  /(?:^|\/)changelogs\//,
  /(?:^|\/)doc\//,
  /(?:^|\/)\.claude\//,
  /(?:^|\/)\.github\//,
  /(?:^|\/)LICENSE$/i,
  /(?:^|\/)\.gitignore$/,
  /(?:^|\/)\.editorconfig$/,
];

/**
 * 热重载安全的应用代码 — 进 cds/src 或 cds/web/src 的 .ts/.tsx,
 * 但不在 RESTART_PATTERNS 里。
 */
function isHotReloadable(p: string): boolean {
  return /^cds\/(?:src|web\/src)\/.+\.(?:ts|tsx|js|jsx|css|html|svg)$/.test(p);
}

export function analyzeChangeImpact(changedPaths: string[]): ChangeImpactResult {
  const restartTriggers: Array<{ path: string; reason: string }> = [];
  const hotReloadablePaths: string[] = [];
  const irrelevantPaths: string[] = [];

  for (const p of changedPaths) {
    // 1) 完全无影响优先短路
    if (IRRELEVANT_PATTERNS.some((re) => re.test(p))) {
      irrelevantPaths.push(p);
      continue;
    }
    // 2) 必须重启的硬规则
    const trigger = RESTART_PATTERNS.find((r) => r.pattern.test(p));
    if (trigger) {
      restartTriggers.push({ path: p, reason: trigger.reason });
      continue;
    }
    // 3) 应用代码 → 热重载安全
    if (isHotReloadable(p)) {
      hotReloadablePaths.push(p);
      continue;
    }
    // 4) 落到这里:未知文件,保守起见标"必须重启"
    restartTriggers.push({ path: p, reason: '未知改动,保守判定为重启' });
  }

  return {
    needsRestart: restartTriggers.length > 0,
    restartTriggers,
    hotReloadablePaths,
    irrelevantPaths,
  };
}
