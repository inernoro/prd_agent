import fs from 'node:fs';
import path from 'node:path';
import type { BtConfig } from './types.js';

const DEFAULT_CONFIG: BtConfig = {
  repoRoot: path.resolve(process.cwd(), '..'),
  worktreeBase: path.resolve(process.cwd(), '..', '.bt-worktrees'),
  deployDir: 'deploy',
  gateway: {
    containerName: 'prdagent-gateway',
    port: 5500,
  },
  docker: {
    network: 'prdagent-network',
    apiDockerfile: 'prd-api/Dockerfile',
    apiImagePrefix: 'prdagent-server',
    containerPrefix: 'prdagent-api',
  },
  mongodb: {
    containerHost: 'mongodb',
    port: 27017,
    defaultDbName: 'prdagent',
  },
  redis: {
    connectionString: 'redis:6379',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-change-me-32bytes-minimum!!',
    issuer: 'prdagent',
  },
  dashboard: {
    port: 9900,
  },
};

export function loadConfig(configPath?: string): BtConfig {
  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const override = JSON.parse(raw) as Partial<BtConfig>;
    return deepMerge(DEFAULT_CONFIG, override);
  }
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
