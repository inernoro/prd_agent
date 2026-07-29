import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { discoverComposeFiles, parseCdsCompose } from '../../src/services/compose-parser.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('存储提供商环境合同', () => {
  it('本地开发不把 auto 字面值复制为 expected provider', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'docker-compose.dev.yml'), 'utf8');

    expect(source).toContain('ASSETS_PROVIDER=${ASSETS_PROVIDER:-local}');
    expect(source).not.toContain('ASSETS_EXPECTED_PROVIDER=');
  });

  it('CDS 三条 compose 导入路径共用结构环境迁移规则', () => {
    for (const relativePath of [
      'cds/src/routes/pending-import.ts',
      'cds/src/routes/projects.ts',
      'cds/src/routes/branches.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).toContain('planImportedEnvSeedWrites(');
    }
  });

  it('CDS 实际优先发现的根配置固定使用 Cloudflare R2', () => {
    const discovered = discoverComposeFiles(repoRoot);
    expect(path.basename(discovered[0])).toBe('cds-compose.yml');

    const source = fs.readFileSync(discovered[0], 'utf8');
    const parsed = parseCdsCompose(source);

    expect(parsed).not.toBeNull();
    expect(parsed?.envVars.ASSETS_PROVIDER).toBe('cloudflareR2');
    expect(parsed?.envVars.ASSETS_EXPECTED_PROVIDER).toBe('cloudflareR2');
    expect(source).not.toContain('TENCENT_COS_');
  });

  it('正式环境配置固定使用 Tencent COS 且不包含 R2 变量', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const compose = yaml.load(source) as {
      services?: Record<string, { environment?: string[] | Record<string, string> }>;
    };
    const environments = Object.values(compose.services || {})
      .flatMap((service) => {
        if (Array.isArray(service.environment)) return service.environment;
        return Object.entries(service.environment || {}).map(([key, value]) => `${key}=${value}`);
      });
    const providers = environments.filter((entry) => entry.startsWith('ASSETS_PROVIDER='));

    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((entry) => entry === 'ASSETS_PROVIDER=tencentCos')).toBe(true);
    expect(environments.some((entry) => entry.startsWith('R2_'))).toBe(false);
  });
});
