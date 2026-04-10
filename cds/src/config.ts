import fs from 'node:fs';
import path from 'node:path';
import type { CdsConfig, CdsMode } from './types.js';

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

const DEFAULT_CONFIG: CdsConfig = {
  repoRoot: path.resolve(process.cwd(), '..'),
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
  schedulerUrl: process.env.CDS_SCHEDULER_URL || undefined,
  executorPort: parseInt(process.env.CDS_EXECUTOR_PORT || '9901', 10),
  executorToken: process.env.CDS_EXECUTOR_TOKEN || undefined,
};

export function loadConfig(configPath?: string): CdsConfig {
  const candidates = [
    configPath,
    path.resolve(process.cwd(), 'cds.config.json'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const override = JSON.parse(raw) as Partial<CdsConfig>;
      console.log(`  Config loaded from: ${candidate}`);
      return deepMerge(DEFAULT_CONFIG, override);
    }
  }

  console.log('  Config: using defaults (no cds.config.json found)');
  return { ...DEFAULT_CONFIG };
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
