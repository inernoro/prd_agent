import fs from 'node:fs';
import path from 'node:path';
import type { CdsConfig } from './types.js';

const DEFAULT_CONFIG: CdsConfig = {
  repoRoot: path.resolve(process.cwd(), '..'),
  worktreeBase: path.resolve(process.cwd(), '..', '.cds-worktrees'),
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: buildSharedEnv(),
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-change-me-32bytes-minimum!!',
    issuer: 'prdagent',
  },
};

/** Collect shared environment from host (DB, Redis, asset providers, etc.) */
function buildSharedEnv(): Record<string, string> {
  const keys = [
    // Database (raw values, kept for backward compat)
    'MONGODB_HOST', 'MONGODB_USERNAME', 'MONGODB_PASSWORD',
    // Redis (raw values)
    'REDIS_HOST', 'REDIS_PASSWORD',
    // Asset providers
    'ASSETS_PROVIDER',
    'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION',
    'TENCENT_COS_SECRET_ID', 'TENCENT_COS_SECRET_KEY',
    'TENCENT_COS_PUBLIC_BASE_URL', 'TENCENT_COS_PREFIX',
    // Auth & secrets
    'ROOT_ACCESS_USERNAME', 'ROOT_ACCESS_PASSWORD',
    'AI_ACCESS_KEY', 'JWT_SECRET', 'GITHUB_PAT',
    // Pages
    'PAGES_BASE_URL',
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const val = process.env[key];
    if (val !== undefined && val !== '') {
      env[key] = val;
    }
  }

  // Synthesize .NET-style connection strings from individual host/password vars.
  // The .NET app reads MongoDB:ConnectionString (env: MongoDB__ConnectionString)
  // and Redis:ConnectionString (env: Redis__ConnectionString).
  const mongoHost = process.env.MONGODB_HOST;
  const mongoUser = process.env.MONGODB_USERNAME || 'root';
  const mongoPass = process.env.MONGODB_PASSWORD;
  if (mongoHost && !env['MongoDB__ConnectionString']) {
    // MONGODB_HOST may already include port (e.g. "10.7.0.17:57017")
    const mongoAddr = mongoHost.includes(':') ? mongoHost : `${mongoHost}:27017`;
    env['MongoDB__ConnectionString'] = mongoPass
      ? `mongodb://${encodeURIComponent(mongoUser)}:${encodeURIComponent(mongoPass)}@${mongoAddr}/?authSource=admin`
      : `mongodb://${mongoAddr}`;
  }

  const redisHost = process.env.REDIS_HOST;
  const redisPass = process.env.REDIS_PASSWORD;
  if (redisHost && !env['Redis__ConnectionString']) {
    // REDIS_HOST may already include port (e.g. "10.7.0.17:65379")
    const redisAddr = redisHost.includes(':') ? redisHost : `${redisHost}:6379`;
    env['Redis__ConnectionString'] = redisPass
      ? `${redisAddr},password=${redisPass}`
      : redisAddr;
  }

  return env;
}

export function loadConfig(configPath?: string): CdsConfig {
  const candidates = [
    configPath,
    path.resolve(process.cwd(), 'cds.config.json'),
    // Backward compat
    path.resolve(process.cwd(), 'bt.config.json'),
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
