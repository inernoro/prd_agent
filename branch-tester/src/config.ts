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
  // Priority: explicit arg → bt.config.json in cwd → defaults
  const candidates = [
    configPath,
    path.resolve(process.cwd(), 'bt.config.json'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const override = JSON.parse(raw) as Partial<BtConfig>;
      console.log(`  Config loaded from: ${candidate}`);
      return deepMerge(DEFAULT_CONFIG, override);
    }
  }

  console.log('  Config: using defaults (no bt.config.json found)');
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
