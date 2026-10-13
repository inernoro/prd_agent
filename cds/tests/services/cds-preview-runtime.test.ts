import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCdsCompose } from '../../src/services/compose-parser.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import type { BranchEntry } from '../../src/types.js';

describe('CDS Self 预构建预览契约', () => {
  it('导入真实 compose 后能按精确 SHA 解析隔离运行模式', () => {
    const parsed = parseCdsCompose(fs.readFileSync(path.resolve('cds-compose.selfhost.yml'), 'utf8'))!;
    const profile = parsed.buildProfiles.find((item) => item.id === 'cds')!;
    const branch = { id: 'self-feature', branch: 'feature/classifications', githubCommitSha: 'a'.repeat(40),
      profileOverrides: { cds: { activeDeployMode: 'express' } } } as unknown as BranchEntry;
    const effective = resolveEffectiveProfile(profile, branch);
    expect(effective.prebuiltImage).toBe(true);
    expect(effective.dockerImage).toBe(`ghcr.io/inernoro/prd_agent/cds-preview:sha-${'a'.repeat(40)}`);
    expect(effective.command).toBe('cd /app/cds && node dist/index.js');
    expect(effective.env).toMatchObject({ CDS_PREVIEW_INSTANCE: '1', CDS_STORAGE_MODE: 'json', CDS_REPO_ROOT: '/app' });
    expect(effective.buildScope).toEqual(['cds/**', '.github/workflows/cds-prebuilt.yml']);
  });
});
