import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { StateService } from '../../src/services/state.js';
import { projectHistoricalSlugs, projectResourceNamespace } from '../../src/services/preview-slug.js';
import { importLegacyProjectSlug, publicIdentityRecord } from '../../src/services/project-identity-history.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { Project } from '../../src/types.js';

describe('项目只保留一个 slug', () => {
  let dir: string;
  let file: string;
  const now = '2026-10-09T00:00:00Z';
  const project = (id: string, slug: string, aliasSlug?: string) => ({
    id, slug, ...(aliasSlug === undefined ? {} : { aliasSlug }), name: id, kind: 'git', createdAt: now, updatedAt: now,
    dockerNetwork: `cds-proj-${id}`,
  });
  const seed = (projects: unknown[]) => fs.writeFileSync(file, JSON.stringify({
    projects, buildProfiles: [], infraServices: [], routingRules: [], nextPortIndex: 0,
    branches: { 'old-project-codex-demo': {
      id: 'old-project-codex-demo', projectId: 'p1', branch: 'codex/demo',
      worktreePath: '/tmp/old-project-demo', status: 'running', createdAt: now,
      services: { web: { profileId: 'web', containerName: 'cds-old-project-demo-web', hostPort: 41100, status: 'running' } },
    } }, logs: {}, customEnv: {}, defaultBranch: null,
  }));
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-single-slug-')); file = path.join(dir, 'state.json'); });
  afterEach(async () => { await flushAllJsonStateStores(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('旧别名生效值迁入唯一 slug；物理删除旧字段，重启幂等，已有资源不改名', async () => {
    seed([project('p1', 'old-project', 'short-project')]);
    const state = new StateService(file, dir);
    state.load();
    await state.flush();
    const migrated = state.getProject('p1')!;
    expect(migrated.slug).toBe('short-project');
    expect(migrated).not.toHaveProperty('aliasSlug');
    expect(migrated.dockerNetwork).toBe('cds-proj-p1');
    expect(state.getBranch('old-project-codex-demo')?.services.web.containerName).toBe('cds-old-project-demo-web');
    expect(projectResourceNamespace(migrated)).toBe('old-project');
    expect(projectHistoricalSlugs(migrated)).toEqual(['short-project', 'old-project']);
    expect(migrated.identityHistory?.map((r) => r.kind)).toEqual(['baseline', 'migrated']);
    expect(migrated.identityHistory?.[1]).toMatchObject({
      actor: 'system:single-project-slug', before: { slug: 'old-project' }, after: { slug: 'short-project' },
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0]).not.toHaveProperty('aliasSlug');
    const savedHistory = JSON.stringify(migrated.identityHistory);
    const restarted = new StateService(file, dir);
    restarted.load();
    expect(JSON.stringify(restarted.getProject('p1')?.identityHistory)).toBe(savedHistory);
    expect(restarted.getBranch('old-project-codex-demo')?.projectId).toBe('p1');
    expect(restarted.getProject('old-project')?.id).toBe('p1');
    state.updateProject('p1', { slug: 'next-project' }, { actor: 'user:owner' });
    expect(projectResourceNamespace(state.getProject('p1')!)).toBe('old-project');
  });

  it.each(['taken-project', 'p2', 'invalid_slug'])('迁移遇到冲突或非法旧值 %s 时保留原始配置', async (alias) => {
    seed([project('p1', 'old-project', alias), project('p2', 'taken-project')]);
    const state = new StateService(file, dir);
    expect(() => state.load()).toThrow(/迁移未执行/);
    await state.flush();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')).projects[0];
    expect(raw.slug).toBe('old-project');
    expect(raw.aliasSlug).toBe(alias);
    expect(raw.identityHistory.some((r: { kind: string }) => r.kind === 'migrated')).toBe(false);
  });

  it('旧镜像与旧审计字段只在读入时兼容，对外记录仅返回一个 slug', () => {
    const imported = importLegacyProjectSlug(project('p1', 'old-project', 'short-project') as Project);
    expect(imported.slug).toBe('short-project');
    expect(imported).not.toHaveProperty('aliasSlug');
    expect(importLegacyProjectSlug(imported)).toBe(imported);
    const legacyRecord = { id: 'old', at: now, kind: 'baseline', actor: 'unknown', after: {
      name: 'p1', displayName: 'p1', originalIdentifier: 'old-project', previewIdentifier: 'short-project', repository: '',
    } } as unknown as NonNullable<Project['identityHistory']>[number];
    expect(publicIdentityRecord(legacyRecord).after).toEqual({ name: 'p1', displayName: 'p1', slug: 'short-project', repository: '' });
    expect(legacyRecord.after.originalIdentifier).toBe('old-project');
  });

  it('改名后旧凭据按哈希绑定识别；伪造前缀、撤销授权及吊销仍拒绝', () => {
    const state = new StateService(file, dir); state.load();
    state.addProject(project('p1', 'old-project') as Project);
    const key = 'cdsp_old-project_local-regression-key';
    state.addPrincipal({ id: 'machine', name: '验证机器', kind: 'machine', status: 'active', createdAt: now });
    state.addProjectGrant({ id: 'grant', projectId: 'p1', principalId: 'machine', origin: 'approved', grantedAt: now });
    state.addAgentKey('p1', { id: 'key', label: '验证', hash: crypto.createHash('sha256').update(key).digest('hex'),
      scope: 'rw', createdAt: now, principalId: 'machine', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    state.updateProject('p1', { slug: 'next-project' });
    expect(state.findAgentKeyForAuth(key)).toEqual({ projectId: 'p1', keyId: 'key' });
    expect(state.findAgentKeyForAuth(key.replace('old-project', 'next-project'))).toBeNull();
    state.revokeProjectGrant('grant');
    expect(state.findAgentKeyForAuth(key)).toBeNull();
    state.addProjectGrant({ id: 'grant2', projectId: 'p1', principalId: 'machine', origin: 'approved', grantedAt: now });
    expect(state.findAgentKeyForAuth(key)).not.toBeNull();
    state.revokeAgentKey('p1', 'key');
    expect(state.findAgentKeyForAuth(key)).toBeNull();
  });
});
