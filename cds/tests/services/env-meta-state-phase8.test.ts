/**
 * Phase 8 — StateService.envMeta + defaultEnv + getMissingRequiredEnvKeys 测试。
 *
 * 锁住"deploy 前 block 用户必填项 + defaultEnv 给新分支继承"的契约。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import type { EnvMeta } from '../../src/types.js';

describe('Phase 8 — StateService.envMeta', () => {
  let tmpDir: string;
  let svc: StateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-env-meta-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    svc = new StateService(stateFile, tmpDir);
    svc.load();
    svc.addProject({
      id: 'projA',
      slug: 'proj-a',
      name: 'Project A',
      kind: 'git',
      dockerNetwork: 'cds-proj-a',
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setEnvMeta + getEnvMeta 往返', () => {
    const meta: Record<string, EnvMeta> = {
      POSTGRES_PASSWORD: { kind: 'auto', hint: '自动生成' },
      SMTP_PASSWORD: { kind: 'required', hint: '请填' },
      DATABASE_URL: { kind: 'infra-derived' },
    };
    svc.setEnvMeta('projA', meta);
    expect(svc.getEnvMeta('projA')).toEqual(meta);
  });

  it('upsertEnvMetaEntry 单 key 更新不影响其他', () => {
    svc.setEnvMeta('projA', {
      A: { kind: 'auto' },
      B: { kind: 'required' },
    });
    svc.upsertEnvMetaEntry('projA', 'C', { kind: 'required', hint: 'new' });
    const meta = svc.getEnvMeta('projA');
    expect(meta.A.kind).toBe('auto');
    expect(meta.B.kind).toBe('required');
    expect(meta.C).toEqual({ kind: 'required', hint: 'new' });
  });

  it('getMissingRequiredEnvKeys: required 项空值才算缺,auto 不算', () => {
    svc.setEnvMeta('projA', {
      SMTP_PASSWORD: { kind: 'required' },
      OAUTH_SECRET: { kind: 'required' },
      JWT_SECRET: { kind: 'auto' },
      DATABASE_URL: { kind: 'infra-derived' },
    });
    // 啥都没填
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual([
      'SMTP_PASSWORD',
      'OAUTH_SECRET',
    ]);
    // 填一个
    svc.setCustomEnvVar('SMTP_PASSWORD', 'mypass', 'projA');
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual(['OAUTH_SECRET']);
    // 全填了
    svc.setCustomEnvVar('OAUTH_SECRET', 'secret', 'projA');
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual([]);
  });

  it('getMissingRequiredEnvKeys: 空字符串和只含空格也算缺', () => {
    svc.setEnvMeta('projA', { SMTP_PASSWORD: { kind: 'required' } });
    svc.setCustomEnvVar('SMTP_PASSWORD', '', 'projA');
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual(['SMTP_PASSWORD']);
    svc.setCustomEnvVar('SMTP_PASSWORD', '   ', 'projA');
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual(['SMTP_PASSWORD']);
  });

  it('getMissingRequiredEnvKeys: 项目无 envMeta(老项目)→ 不 block', () => {
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual([]);
  });

  it('getMissingRequiredEnvKeys: 不存在的项目 → 空数组(不 throw)', () => {
    expect(svc.getMissingRequiredEnvKeys('nonexistent')).toEqual([]);
  });

  // Bugbot regression(PR #521)— 之前 getMissingRequiredEnvKeys 只读
  // project.customEnv,漏 _global scope。修复后用 getCustomEnv(projectId) 走
  // merged env(_global ⊕ project),与 deploy 时容器实际 env 一致 — 否则在
  // _global 设了 SMTP_PASSWORD 也会被误判 missing → 假 412 deploy block。
  it('getMissingRequiredEnvKeys: _global scope 设的 required 也算填了(Bugbot regression)', () => {
    svc.setEnvMeta('projA', {
      SMTP_PASSWORD: { kind: 'required' },
      OAUTH_SECRET: { kind: 'required' },
    });
    // 只在 _global 设 SMTP_PASSWORD,project 不设
    svc.setCustomEnvVar('SMTP_PASSWORD', 'global-value', '_global');
    // _global 不该被认为 missing,但 OAUTH_SECRET 仍 missing
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual(['OAUTH_SECRET']);
    // 项目级覆盖优先(getCustomEnv 合并语义)
    svc.setCustomEnvVar('OAUTH_SECRET', 'proj-value', 'projA');
    expect(svc.getMissingRequiredEnvKeys('projA')).toEqual([]);
  });

  it('setDefaultEnv + getDefaultEnv 往返', () => {
    const env = { JWT_SECRET: 'aaa', SMTP_HOST: 'smtp.gmail.com' };
    svc.setDefaultEnv('projA', env);
    expect(svc.getDefaultEnv('projA')).toEqual(env);
  });

  it('defaultEnv 与 customEnv 独立(不联动)', () => {
    svc.setDefaultEnv('projA', { K: 'default' });
    svc.setCustomEnvVar('K', 'runtime', 'projA');
    // defaultEnv 是新分支模板,customEnv 是当前生效值
    expect(svc.getDefaultEnv('projA')).toEqual({ K: 'default' });
    expect(svc.getCustomEnvScope('projA')).toEqual({ K: 'runtime' });
  });

  it('不存在的项目 setEnvMeta / setDefaultEnv 静默 noop', () => {
    expect(() => svc.setEnvMeta('nope', { A: { kind: 'auto' } })).not.toThrow();
    expect(() => svc.setDefaultEnv('nope', { K: 'V' })).not.toThrow();
    expect(svc.getEnvMeta('nope')).toEqual({});
    expect(svc.getDefaultEnv('nope')).toEqual({});
  });
});
