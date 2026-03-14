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
  sharedEnv: {},
  // CDS_ prefix preferred; legacy names (SWITCH_DOMAIN, etc.) kept for backward compat
  switchDomain: process.env.CDS_SWITCH_DOMAIN || process.env.SWITCH_DOMAIN || undefined,
  mainDomain: process.env.CDS_MAIN_DOMAIN || process.env.MAIN_DOMAIN || undefined,
  previewDomain: process.env.CDS_PREVIEW_DOMAIN || process.env.PREVIEW_DOMAIN || undefined,
  jwt: {
    secret: process.env.CDS_JWT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only-change-me-32bytes-minimum!!',
    issuer: 'prdagent',
  },
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
