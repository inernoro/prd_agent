/**
 * 预览实例模式（CDS 托管 CDS，MVP）单测。
 *
 * 锁三件事：
 *   1. isPreviewInstance 的 env 解析口径；
 *   2. findBlockedBinary / PreviewInstanceShellExecutor 对宿主操作命令的拦截边界
 *      （docker/systemctl 等被拦，git/node 等放行，sudo/env/VAR= 前缀与管道、&& 链都覆盖）；
 *   3. seedPreviewInstanceDemoData 的幂等与「非空库不碰」保护。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isPreviewInstance,
  findBlockedBinary,
  PreviewInstanceShellExecutor,
  previewInstanceBlockedMessage,
  scrubParentSecretsFromEnv,
} from '../../src/services/preview-instance.js';
import { seedPreviewInstanceDemoData, PREVIEW_DEMO_PROJECT_ID } from '../../src/services/preview-instance-seed.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

describe('isPreviewInstance', () => {
  it('accepts 1/true/yes/on (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(isPreviewInstance({ CDS_PREVIEW_INSTANCE: v })).toBe(true);
    }
  });

  it('rejects empty / 0 / false / garbage', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'nope']) {
      expect(isPreviewInstance({ CDS_PREVIEW_INSTANCE: v })).toBe(false);
    }
  });
});

describe('scrubParentSecretsFromEnv', () => {
  it('removes parent-secret-looking keys including inherited CDS_PASSWORD, remaps CDS_PREVIEW_* gate', () => {
    const env: NodeJS.ProcessEnv = {
      CDS_PREVIEW_INSTANCE: '1',
      LLMGW_ADMIN_PASSWORD: 'leak',
      JWT_SECRET: 'leak',
      CDS_JWT_SECRET: 'leak',
      AI_ACCESS_KEY: 'leak',
      GITHUB_TOKEN: 'leak',
      TENCENT_COS_SECRET_KEY: 'leak',
      // URI 型连接串同样是父实例入口（Codex P1）：不含 PASSWORD 字样但
      // httpLogStoreFromEnv 等直接消费
      CDS_MONGO_URI: 'mongodb://parent:27017',
      DATABASE_URL: 'postgres://parent/db',
      CDS_REDIS_HOST: 'parent-redis',
      ConnectionStrings__Default: 'Server=parent',
      // 继承来的通用 CDS_PASSWORD 可能是父实例门禁密码（Codex P1）→ 必须清
      CDS_PASSWORD: 'parent-gate-leak',
      // 子实例专用凭据 → 清洗后重映射
      CDS_PREVIEW_USERNAME: 'child-admin',
      CDS_PREVIEW_PASSWORD: 'child-gate',
      CDS_PREVIEW_SSO_ENABLED: '1',
      CDS_PREVIEW_SSO_AUTHORIZATION_URL: 'https://map.example/api/console-sso/authorize',
      CDS_PREVIEW_SSO_TOKEN_URL: 'https://map.example/api/console-sso/token',
      CDS_PREVIEW_SSO_CLIENT_ID: 'cds-console',
      CDS_PREVIEW_SSO_CLIENT_SECRET: 'sso-child-secret',
      CDS_HOST: 'keep',
      ASSETS_PROVIDER: 'keep',
    };
    const scrubbed = scrubParentSecretsFromEnv(env);
    expect(scrubbed.sort()).toEqual([
      'AI_ACCESS_KEY', 'CDS_JWT_SECRET', 'CDS_MONGO_URI', 'CDS_PASSWORD',
      'CDS_PREVIEW_PASSWORD', 'CDS_PREVIEW_SSO_AUTHORIZATION_URL',
      'CDS_PREVIEW_SSO_CLIENT_SECRET', 'CDS_PREVIEW_SSO_TOKEN_URL', 'CDS_REDIS_HOST',
      'ConnectionStrings__Default', 'DATABASE_URL', 'GITHUB_TOKEN', 'JWT_SECRET',
      'LLMGW_ADMIN_PASSWORD', 'TENCENT_COS_SECRET_KEY',
    ]);
    expect(env.CDS_MONGO_URI).toBeUndefined();
    // 父实例门禁密码没有幸存；子实例门禁来自专用键的重映射，auth mode 强制 basic
    expect(env.CDS_PASSWORD).toBe('child-gate');
    expect(env.CDS_USERNAME).toBe('child-admin');
    expect(env.CDS_AUTH_MODE).toBe('basic');
    expect(env.CDS_SSO_ENABLED).toBe('1');
    expect(env.CDS_SSO_AUTHORIZATION_URL).toBe('https://map.example/api/console-sso/authorize');
    expect(env.CDS_SSO_TOKEN_URL).toBe('https://map.example/api/console-sso/token');
    expect(env.CDS_SSO_CLIENT_ID).toBe('cds-console');
    expect(env.CDS_SSO_CLIENT_SECRET).toBe('sso-child-secret');
    expect(env.CDS_HOST).toBe('keep');
    expect(env.ASSETS_PROVIDER).toBe('keep');
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('leaves no basic-auth gate when CDS_PREVIEW_* is absent (inherited password still scrubbed)', () => {
    // 继承的 CDS_AUTH_MODE=github 同样不可信：凭据已被清洗，归一化为 disabled
    const env: NodeJS.ProcessEnv = { CDS_PREVIEW_INSTANCE: '1', CDS_PASSWORD: 'parent-gate-leak', CDS_AUTH_MODE: 'github' };
    const scrubbed = scrubParentSecretsFromEnv(env);
    expect(scrubbed).toEqual(['CDS_PASSWORD']);
    expect(env.CDS_PASSWORD).toBeUndefined();
    expect(env.CDS_AUTH_MODE).toBe('disabled');
  });

  it('is a no-op outside preview instances', () => {
    const env: NodeJS.ProcessEnv = { JWT_SECRET: 'stay' };
    expect(scrubParentSecretsFromEnv(env)).toEqual([]);
    expect(env.JWT_SECRET).toBe('stay');
  });
});

describe('findBlockedBinary', () => {
  it('blocks host-mutation binaries at segment head', () => {
    expect(findBlockedBinary('docker ps -a')).toBe('docker');
    expect(findBlockedBinary('systemctl restart cds-master')).toBe('systemctl');
    expect(findBlockedBinary('nginx -t')).toBe('nginx');
    expect(findBlockedBinary('journalctl -u cds-master -n 50')).toBe('journalctl');
  });

  it('sees through sudo / env / VAR= prefixes and absolute paths', () => {
    expect(findBlockedBinary('sudo docker rm -f x')).toBe('docker');
    expect(findBlockedBinary('FOO=1 BAR=2 docker build .')).toBe('docker');
    expect(findBlockedBinary('env DOCKER_HOST=tcp://x docker info')).toBe('docker');
    expect(findBlockedBinary('/usr/bin/systemctl daemon-reload')).toBe('systemctl');
  });

  it('scans every && / ; / | segment', () => {
    expect(findBlockedBinary('cd /tmp && docker compose up')).toBe('docker');
    expect(findBlockedBinary('echo hi; docker ps')).toBe('docker');
    expect(findBlockedBinary('cat file | docker load')).toBe('docker');
    expect(findBlockedBinary('git fetch || docker restart x')).toBe('docker');
  });

  it('lets read-only / in-process commands through', () => {
    expect(findBlockedBinary('git rev-parse HEAD')).toBeNull();
    expect(findBlockedBinary('pnpm install --frozen-lockfile')).toBeNull();
    expect(findBlockedBinary('node dist/index.js')).toBeNull();
    // 名称只是包含 docker 的普通参数不误伤
    expect(findBlockedBinary('grep docker README.md')).toBeNull();
    expect(findBlockedBinary('echo docker')).toBeNull();
  });
});

describe('PreviewInstanceShellExecutor', () => {
  it('short-circuits blocked commands with a friendly message and exitCode 1', async () => {
    const inner = new MockShellExecutor();
    const wrapped = new PreviewInstanceShellExecutor(inner);
    const chunks: string[] = [];
    const result = await wrapped.exec('docker ps', { onData: (d) => chunks.push(d) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(previewInstanceBlockedMessage('docker'));
    expect(result.stderr).toContain('预览实例');
    expect(chunks.join('')).toContain('预览实例');
    // 内层 executor 完全没被触达
    expect(inner.commands).toHaveLength(0);
  });

  it('delegates allowed commands to the inner executor untouched', async () => {
    const inner = new MockShellExecutor();
    inner.addResponse('git status', { stdout: 'clean', stderr: '', exitCode: 0 });
    const wrapped = new PreviewInstanceShellExecutor(inner);
    const result = await wrapped.exec('git status');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('clean');
    expect(inner.commands).toEqual(['git status']);
  });
});

describe('seedPreviewInstanceDemoData', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-preview-instance-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('seeds demo project + branches + profiles into an empty store', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    const project = service.getProject(PREVIEW_DEMO_PROJECT_ID);
    expect(project?.name).toContain('演示');
    const branches = service.getAllBranches();
    expect(branches).toHaveLength(3);
    expect(new Set(branches.map((b) => b.status))).toEqual(new Set(['running', 'error', 'idle']));
    // 每条演示分支都显式标注，不冒充真实部署（no-rootless-tree）
    for (const b of branches) expect(b.notes).toContain('演示数据');
    expect(service.getBuildProfiles().filter((p) => p.projectId === PREVIEW_DEMO_PROJECT_ID)).toHaveLength(2);
    expect(service.getActivityLogs(PREVIEW_DEMO_PROJECT_ID).length).toBeGreaterThan(0);
  });

  it('is idempotent — second call is a no-op', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    expect(seedPreviewInstanceDemoData(service)).toBe(false);
    expect(service.getAllBranches()).toHaveLength(3);
  });

  it('never touches a store that already has data', () => {
    const now = new Date().toISOString();
    service.addProject({ id: 'real', slug: 'real', name: 'Real Project', kind: 'git', createdAt: now, updatedAt: now });
    expect(seedPreviewInstanceDemoData(service)).toBe(false);
    expect(service.getProject(PREVIEW_DEMO_PROJECT_ID)).toBeUndefined();
  });
});
