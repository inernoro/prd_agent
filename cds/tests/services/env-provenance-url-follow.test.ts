/**
 * 收敛 2 在溯源与配置检查器上的落地：
 *   - 跟随改写的连接串在溯源里标 per-branch-db / per-branch-db-url；
 *   - 没跟随的连接串（指向别的库）在返回结果里单独列出，配置检查器据此标「连接串未跟随」；
 *   - 接线守卫：effective-config 路由把它透传，面板渲染它。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfileRuntimeEnvWithProvenance } from '../../src/services/env-provenance.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const branch = { id: 'p-feat-x', projectId: 'p', branch: 'feat/x', worktreePath: '/x', services: {}, status: 'idle', createdAt: '2026-09-03T00:00:00Z' } as unknown as BranchEntry;
const profile = (env: Record<string, string>): BuildProfile => ({
  id: 'api', projectId: 'p', name: 'api', dockerImage: 'node:20', workDir: '.', containerPort: 3000, dbScope: 'per-branch', env,
} as BuildProfile);

describe('溯源：连接串跟随', () => {
  it('跟随改写的连接串标 per-branch-db-url，库名变量仍标 per-branch-db-suffix', () => {
    const r = resolveProfileRuntimeEnvWithProvenance(branch, profile({
      CDS_MYSQL_DATABASE: 'app', DATABASE_URL: 'mysql://mysql:3306/app',
    }), [], [{ source: 'profile', env: { CDS_MYSQL_DATABASE: 'app', DATABASE_URL: 'mysql://mysql:3306/app' } }], { jwtIssuer: 'cds', injectBullmqPrefix: false });
    expect(r.env.DATABASE_URL).toBe('mysql://mysql:3306/app_feat_x');
    const byKey = Object.fromEntries(r.provenance.map((p) => [p.key, p]));
    expect(byKey.CDS_MYSQL_DATABASE).toMatchObject({ source: 'per-branch-db', detail: 'per-branch-db-suffix' });
    expect(byKey.DATABASE_URL).toMatchObject({ source: 'per-branch-db', detail: 'per-branch-db-url' });
    expect(r.perBranchDb?.unfollowedUrls ?? []).toEqual([]);
  });

  it('指向别的库的连接串不改，但在 perBranchDb.unfollowedUrls 里报出来', () => {
    const env = { CDS_MYSQL_DATABASE: 'app', REPORTING_URL: 'mysql://mysql:3306/reporting' };
    const r = resolveProfileRuntimeEnvWithProvenance(branch, profile(env), [], [{ source: 'profile', env }], { jwtIssuer: 'cds', injectBullmqPrefix: false });
    expect(r.env.REPORTING_URL).toBe('mysql://mysql:3306/reporting');
    expect(r.perBranchDb?.unfollowedUrls.map((u) => u.key)).toEqual(['REPORTING_URL']);
  });
});

describe('接线守卫：未跟随的连接串要一路透到配置检查器', () => {
  it('effective-config 路由透传 dbUrlUnfollowed，面板渲染「连接串未跟随」', () => {
    const route = fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
    const layers = fs.readFileSync(path.join(CDS_ROOT, 'src/services/branch-env-layers.ts'), 'utf8');
    const panel = fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/branch/EffectiveConfigPanel.tsx'), 'utf8');
    expect(layers).toContain('perBranchDb');
    expect(route).toContain('dbUrlUnfollowed');
    expect(panel).toContain('dbUrlUnfollowed');
    expect(panel).toContain('连接串未跟随');
    expect(panel).toContain("'per-branch-db-url'");
  });
});
