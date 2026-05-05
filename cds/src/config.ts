import fs from 'node:fs';
import path from 'node:path';
import type { CdsConfig, CdsMode, GitHubAppConfig } from './types.js';

// ⚠️ side-effect import：必须在 DEFAULT_CONFIG 求值之前把 .cds.env 注入 process.env。
// ES module 顶层导入会先评估被导入模块的 top-level 代码，所以这一行保证 env
// 在下方 `DEFAULT_CONFIG.githubApp = resolveGitHubApp()` 之前就位。
// 缺这行 → GitHub App config 永远 undefined → webhook 拒收 503。详见 load-env.ts 注释。
import './load-env.js';

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(v => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function resolveMode(): CdsMode {
  const env = (process.env.CDS_MODE || '').toLowerCase();
  if (env === 'scheduler' || env === 'executor') return env;
  return 'standalone';
}

const configuredRootDomains = parseCsv(process.env.CDS_ROOT_DOMAINS || process.env.ROOT_DOMAINS);
const primaryRootDomain = configuredRootDomains?.[0];

/**
 * Resolve the GitHub App credentials from env vars so operators can keep
 * the PEM private key in `.cds.env` (produced by `exec_cds.sh`) without
 * hand-editing cds.config.json. Returns undefined when any required field
 * is missing — the webhook router and deploy-side check-run hooks both
 * tolerate the dormant state and short-circuit to a friendly 503 / no-op.
 *
 * Env contract:
 *   CDS_GITHUB_APP_ID              — numeric App ID (required)
 *   CDS_GITHUB_APP_PRIVATE_KEY     — PEM, literal `\n` tolerated (required)
 *   CDS_GITHUB_WEBHOOK_SECRET      — HMAC-SHA256 secret (required)
 *   CDS_GITHUB_APP_SLUG            — optional, only for rendering install URL
 */
function resolveGitHubApp(): GitHubAppConfig | undefined {
  const appId = process.env.CDS_GITHUB_APP_ID?.trim();
  const rawKey = process.env.CDS_GITHUB_APP_PRIVATE_KEY?.trim();
  const webhookSecret = process.env.CDS_GITHUB_WEBHOOK_SECRET?.trim();
  if (!appId || !rawKey || !webhookSecret) return undefined;
  // PEM keys embedded in env vars often arrive with literal `\n` instead of
  // real newlines. Accept both so `.cds.env` and docker-compose env work.
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return {
    appId,
    privateKey,
    webhookSecret,
    appSlug: process.env.CDS_GITHUB_APP_SLUG?.trim() || undefined,
  };
}

function resolveBootstrapToken(): { value: string; expiresAt: string } | undefined {
  const value = process.env.CDS_BOOTSTRAP_TOKEN;
  const expiresAt = process.env.CDS_BOOTSTRAP_TOKEN_EXPIRES_AT;
  if (!value || !expiresAt) return undefined;
  // Expired tokens are swallowed at load time so the master doesn't accept
  // stale credentials after a reboot. The env vars themselves are pruned by
  // `./exec_cds.sh issue-token` on the next run or by `cleanupExpiredToken`.
  if (new Date(expiresAt).getTime() < Date.now()) return undefined;
  return { value, expiresAt };
}

// `schedulerUrl` is the internal field ExecutorAgent already uses; `masterUrl`
// is the user-facing field written by `./exec_cds.sh connect`. We honor both
// so existing CDS_SCHEDULER_URL deployments keep working while new clusters
// use the friendlier CDS_MASTER_URL name.
const masterUrl = process.env.CDS_MASTER_URL || undefined;
const schedulerUrl = process.env.CDS_SCHEDULER_URL || masterUrl || undefined;

const DEFAULT_CONFIG: CdsConfig = {
  repoRoot: path.resolve(process.cwd(), '..'),
  // P4 Part 18 (G1.4): reposBase is the mount point under which
  // per-project clones live (`${reposBase}/<projectId>`). Default
  // reads CDS_REPOS_BASE env (set by exec_cds.sh bind-mount) — when
  // empty the multi-repo clone flow is effectively disabled and
  // every project falls back to repoRoot.
  reposBase: process.env.CDS_REPOS_BASE || undefined,
  worktreeBase: path.resolve(process.cwd(), '..', '.cds-worktrees'),
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: {},
  // CDS_ prefix preferred; legacy names (SWITCH_DOMAIN, etc.) kept for backward compat
  switchDomain: process.env.CDS_SWITCH_DOMAIN || process.env.SWITCH_DOMAIN || undefined,
  mainDomain: process.env.CDS_MAIN_DOMAIN || process.env.MAIN_DOMAIN || primaryRootDomain || undefined,
  dashboardDomain: process.env.CDS_DASHBOARD_DOMAIN || process.env.DASHBOARD_DOMAIN || primaryRootDomain || undefined,
  rootDomains: configuredRootDomains,
  previewDomain: process.env.CDS_PREVIEW_DOMAIN || process.env.PREVIEW_DOMAIN || primaryRootDomain || undefined,
  jwt: {
    secret: process.env.CDS_JWT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only-change-me-32bytes-minimum!!',
    issuer: 'prdagent',
  },
  mode: resolveMode(),
  schedulerUrl,
  masterUrl,
  executorPort: parseInt(process.env.CDS_EXECUTOR_PORT || '9901', 10),
  executorToken: process.env.CDS_EXECUTOR_TOKEN || undefined,
  bootstrapToken: resolveBootstrapToken(),
  // Warm-pool scheduler — disabled by default for backward compatibility.
  // Opt-in via cds.config.json { "scheduler": { "enabled": true, ... } }.
  // See doc/design.cds-resilience.md.
  scheduler: {
    enabled: false,
    maxHotBranches: 3,
    idleTTLSeconds: 900,
    tickIntervalSeconds: 60,
    pinnedBranches: [],
  },
  // Janitor (Phase 2) — off by default, same opt-in philosophy as scheduler.
  // Disk warnings still fire when enabled=true even if nothing to delete.
  janitor: {
    enabled: false,
    worktreeTTLDays: 30,
    diskWarnPercent: 80,
    sweepIntervalSeconds: 3600,
  },
  // GitHub App credentials for the Railway-style check-run integration.
  // Absent when any of CDS_GITHUB_APP_ID / _PRIVATE_KEY / _WEBHOOK_SECRET
  // is unset — the webhook route returns 503 not_configured in that case.
  // ⚠️ 在 loadConfig() 函数体里 lazy 求值，不要放这里！原版本是
  //   `githubApp: resolveGitHubApp()` 直接 module-level 调用，
  // 但 ES module 顶层求值时机和 self-loader (load-env.ts) 完成时机
  // 不能 100% 保证有先后关系（受 import 拓扑顺序、tsc-incremental
  // 缓存、循环依赖影响），导致 process.env 还没注入就读完了。改成
  // 在 loadConfig() 里读，那一刻 self-loader 必定已跑完。
  githubApp: undefined,
  // Public-facing base URL — 同样 lazy 化，规避 module-level 求值陷阱
  publicBaseUrl: undefined,
};

export function loadConfig(configPath?: string): CdsConfig {
  // ⚠️ Lazy env reads —— 这里 (loadConfig 调用时) self-loader (load-env.ts)
  // 一定已跑完，process.env 已注入磁盘 .cds.env。
  // 历史教训：原版本是 module-level `DEFAULT_CONFIG.githubApp =
  // resolveGitHubApp()`，但 ES module 顶层求值时机受 import 拓扑顺序
  // / tsc-incremental 缓存影响，可能在 self-loader 之前 evaluate，
  // 导致 GitHub App config 永远 undefined → webhook 拒收 503。
  const liveDefaults: CdsConfig = {
    ...DEFAULT_CONFIG,
    githubApp: resolveGitHubApp(),
    publicBaseUrl: process.env.CDS_PUBLIC_BASE_URL?.trim() || undefined,
  };

  if (liveDefaults.githubApp) {
    console.log(`[config] GitHub App configured (appId=${liveDefaults.githubApp.appId})`);
  } else {
    const appId = process.env.CDS_GITHUB_APP_ID?.trim();
    const key = process.env.CDS_GITHUB_APP_PRIVATE_KEY?.trim();
    const secret = process.env.CDS_GITHUB_WEBHOOK_SECRET?.trim();
    console.log(
      `[config] GitHub App NOT configured — appId=${appId ? 'set' : 'EMPTY'} ` +
      `privateKey=${key ? 'len=' + key.length : 'EMPTY'} ` +
      `webhookSecret=${secret ? 'set' : 'EMPTY'}`,
    );
  }

  const candidates = [
    configPath,
    path.resolve(process.cwd(), 'cds.config.json'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const override = JSON.parse(raw) as Partial<CdsConfig>;
      console.log(`  Config loaded from: ${candidate}`);
      return deepMerge(liveDefaults, override);
    }
  }

  console.log('  Config: using defaults (no cds.config.json found)');
  return { ...liveDefaults };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = deepMerge(base[key] ?? {}, val);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}
