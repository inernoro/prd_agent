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
      CDS_PUBLIC_BASE_URL: 'https://parent-cds.example',
      CDS_PREVIEW_PUBLIC_BASE_URL: 'https://preview-cds.example/some/path',
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
      'CDS_PREVIEW_PASSWORD', 'CDS_PREVIEW_PUBLIC_BASE_URL',
      'CDS_PREVIEW_SSO_AUTHORIZATION_URL',
      'CDS_PREVIEW_SSO_CLIENT_SECRET', 'CDS_PREVIEW_SSO_TOKEN_URL', 'CDS_PUBLIC_BASE_URL',
      'CDS_REDIS_HOST', 'ConnectionStrings__Default', 'DATABASE_URL', 'GITHUB_TOKEN', 'JWT_SECRET',
      'LLMGW_ADMIN_PASSWORD', 'TENCENT_COS_SECRET_KEY',
    ]);
    expect(env.CDS_MONGO_URI).toBeUndefined();
    // 父实例门禁密码没有幸存；子实例门禁来自专用键的重映射，auth mode 强制 basic
    expect(env.CDS_PASSWORD).toBe('child-gate');
    expect(env.CDS_USERNAME).toBe('child-admin');
    expect(env.CDS_AUTH_MODE).toBe('basic');
    expect(env.CDS_PUBLIC_BASE_URL).toBe('https://preview-cds.example');
    expect(env.CDS_SSO_ENABLED).toBe('1');
    expect(env.CDS_SSO_AUTHORIZATION_URL).toBe('https://map.example/api/console-sso/authorize');
    expect(env.CDS_SSO_TOKEN_URL).toBe('https://map.example/api/console-sso/token');
    expect(env.CDS_SSO_CLIENT_ID).toBe('cds-console');
    expect(env.CDS_SSO_CLIENT_SECRET).toBe('sso-child-secret');
    expect(env.CDS_HOST).toBe('keep');
    expect(env.ASSETS_PROVIDER).toBe('keep');
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('scrubs the parent AI key but remaps a child-specific CDS_PREVIEW_AI_ACCESS_KEY', () => {
    // 红绿闭环：把 preview-instance.ts 里 `env.CDS_AI_ACCESS_KEY = previewAiAccessKey`
    // 那行删掉，本用例第三条断言变红（拿到 undefined）——它测的是接线，不是常量。
    const env: NodeJS.ProcessEnv = {
      CDS_PREVIEW_INSTANCE: '1',
      // 父实例那两把（能操作生产 CDS）
      AI_ACCESS_KEY: 'parent-key',
      CDS_AI_ACCESS_KEY: 'parent-key-canonical',
      // 为子实例单独生成的那把
      CDS_PREVIEW_AI_ACCESS_KEY: 'child-only-key',
    };

    const scrubbed = scrubParentSecretsFromEnv(env);

    expect(scrubbed).toContain('AI_ACCESS_KEY');
    expect(scrubbed).toContain('CDS_PREVIEW_AI_ACCESS_KEY');
    expect(env.CDS_AI_ACCESS_KEY).toBe('child-only-key');
    expect(env.AI_ACCESS_KEY).toBeUndefined();
  });

  it('leaves no AI key at all when only the parent key was inherited', () => {
    const env: NodeJS.ProcessEnv = { CDS_PREVIEW_INSTANCE: '1', AI_ACCESS_KEY: 'parent-key' };
    scrubParentSecretsFromEnv(env);
    expect(env.AI_ACCESS_KEY).toBeUndefined();
    expect(env.CDS_AI_ACCESS_KEY).toBeUndefined();
  });

  it('keeps preview SSO disabled when no trusted preview public base URL is provided', () => {
    const env: NodeJS.ProcessEnv = {
      CDS_PREVIEW_INSTANCE: '1',
      CDS_PREVIEW_SSO_ENABLED: '1',
      CDS_PREVIEW_SSO_AUTHORIZATION_URL: 'https://map.example/authorize',
      CDS_PREVIEW_SSO_TOKEN_URL: 'https://map.example/token',
      CDS_PREVIEW_SSO_CLIENT_ID: 'cds-console',
      CDS_PREVIEW_SSO_CLIENT_SECRET: 'child-secret',
      CDS_PUBLIC_BASE_URL: 'https://parent-cds.example',
    };

    scrubParentSecretsFromEnv(env);

    expect(env.CDS_PUBLIC_BASE_URL).toBeUndefined();
    expect(env.CDS_SSO_ENABLED).toBe('0');
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
    // 不写死条数：加一条演示数据不该让这条用例红。要成立的是「状态有覆盖面」，
    // 那才是这份 seed 存在的理由（空 dashboard 什么都验收不了）。
    expect(branches.length).toBeGreaterThanOrEqual(3);
    for (const status of ['running', 'error', 'idle']) {
      expect(branches.some((b) => b.status === status)).toBe(true);
    }
    // 每条演示分支都显式标注，不冒充真实部署（no-rootless-tree）
    for (const b of branches) expect(b.notes).toContain('演示数据');
    expect(service.getBuildProfiles().filter((p) => p.projectId === PREVIEW_DEMO_PROJECT_ID)).toHaveLength(2);
    expect(service.getActivityLogs(PREVIEW_DEMO_PROJECT_ID).length).toBeGreaterThan(0);
  });

  it('seeds 任务调度 / 验收报告，让那两页不是空状态', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    const jobs = service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID);
    // 三种 schedule 都要有：分段控件和列表的三种形态都得能看到
    for (const type of ['daily', 'interval', 'manual']) {
      expect(jobs.some((j) => j.schedule.type === type)).toBe(true);
    }
    for (const j of jobs) expect(j.name).toContain('演示数据');
    /*
     * Codex 第二轮 P2：演示任务不许自己跑起来。
     *
     * 调度器在预览实例上照样启动，enabled 的演示任务会被它真的执行——实机验到
     * 「每 30 分钟同步」的 lastRunAt 被改成了当天的真实执行时间。那会把 seed 摆
     * 出来的成功/失败示例状态覆盖掉，还往运行历史里灌噪音。演示数据是给人看的，
     * 不是给调度器跑的。
     */
    for (const j of jobs) expect(j.enabled).toBe(false);
    // 但「上次运行」的示例状态要保住，否则列表那一列全空、看不出成功/失败长什么样
    expect(jobs.some((j) => j.lastRunStatus === 'success')).toBe(true);
    expect(jobs.some((j) => j.lastRunStatus === 'failed')).toBe(true);

    const reports = service.listAcceptanceReports(PREVIEW_DEMO_PROJECT_ID);
    for (const verdict of ['pass', 'conditional', 'fail']) {
      expect(reports.some((r) => r.verdict === verdict)).toBe(true);
    }
    for (const r of reports) expect(r.title).toContain('演示数据');
  });

  it('给「已经播过首播的老实例」补播新增的演示数据', () => {
    // 复现旧版本播下的库：演示项目 + 一条分支，但没有定时任务与验收报告。
    // 预览实例的 state 跨部署保留，如果 seed 是全有或全无的，这种库升级之后
    // 任务调度和验收报告两页会永远空着——这条用例就是钉这个。
    const now = new Date().toISOString();
    service.addProject({
      id: PREVIEW_DEMO_PROJECT_ID, slug: PREVIEW_DEMO_PROJECT_ID,
      name: '演示项目（预览实例）', kind: 'git', createdAt: now, updatedAt: now,
    });
    service.addBranch({
      id: `${PREVIEW_DEMO_PROJECT_ID}-old`, projectId: PREVIEW_DEMO_PROJECT_ID,
      branch: 'feat/old', worktreePath: '/tmp/preview-demo/old', status: 'idle',
      createdAt: now, notes: '演示数据：旧版本播下的分支。', services: {},
    });
    expect(service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID)).toHaveLength(0);

    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    expect(service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID).length).toBeGreaterThan(0);
    expect(service.listAcceptanceReports(PREVIEW_DEMO_PROJECT_ID).length).toBeGreaterThan(0);

    const branches = service.getAllBranches();
    // 老实例已有的那条原样保留（补播只补缺的，不重写既有条目）
    expect(branches.find((b) => b.id === `${PREVIEW_DEMO_PROJECT_ID}-old`)?.branch).toBe('feat/old');
    // 而当前清单里的状态覆盖面必须补齐——线上真的踩过这个洞：预览实例停在
    // 旧版本播下的三条分支上，清单扩到五条之后「构建中 / 冷分支」两种卡片
    // 在实例里从来没出现过。判据钉覆盖面，不钉条数。
    for (const status of ['running', 'error', 'building', 'idle']) {
      expect(branches.some((b) => b.status === status)).toBe(true);
    }
  });

  /*
   * Codex 第四轮 P2：任务和报告仍是整类守卫，只有分支那一档真按 id 补。
   * 这直接违反本文件注释里写的口径（「不能只判这一类有没有」）——老实例只要
   * 已经有任意一条任务，后来新增的演示任务就永远补不进去，而这个函数存在的
   * 理由就是给老实例补东西。
   *
   * 判据钉「删掉其中一条能补回来，且没被补的那些不受影响」。
   */
  it('任务和报告也按身份逐条补，不是整类有无', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    const jobs = service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID);
    const reports = service.listAcceptanceReports(PREVIEW_DEMO_PROJECT_ID);
    expect(jobs.length).toBeGreaterThan(1);
    expect(reports.length).toBeGreaterThan(1);

    // 模拟「老实例只有一条」：删到只剩一条，整类守卫在这种库上会一条都不补。
    const keptJob = jobs[0];
    for (const j of jobs.slice(1)) service.deleteScheduledJob(j.id);
    const keptReport = reports[0];
    for (const r of reports.slice(1)) service.deleteAcceptanceReport(r.id);
    expect(service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID)).toHaveLength(1);

    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    expect(service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID)).toHaveLength(jobs.length);
    expect(service.listAcceptanceReports(PREVIEW_DEMO_PROJECT_ID)).toHaveLength(reports.length);
    // 留下的那条原样不动，没有被重播成新的
    expect(service.listScheduledJobs(PREVIEW_DEMO_PROJECT_ID).find((j) => j.id === keptJob.id)?.name)
      .toBe(keptJob.name);
    expect(service.listAcceptanceReports(PREVIEW_DEMO_PROJECT_ID).some((r) => r.id === keptReport.id))
      .toBe(true);
  });

  it('补播只补缺的分支，第二次调用不再产生副作用', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    const first = service.getAllBranches().map((b) => b.id).sort();
    expect(seedPreviewInstanceDemoData(service)).toBe(false);
    expect(service.getAllBranches().map((b) => b.id).sort()).toEqual(first);
  });

  it('is idempotent — second call is a no-op', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    const seeded = service.getAllBranches().length;
    expect(seedPreviewInstanceDemoData(service)).toBe(false);
    expect(service.getAllBranches()).toHaveLength(seeded);
  });

  it('never touches a store that already has data', () => {
    const now = new Date().toISOString();
    service.addProject({ id: 'real', slug: 'real', name: 'Real Project', kind: 'git', createdAt: now, updatedAt: now });
    expect(seedPreviewInstanceDemoData(service)).toBe(false);
    expect(service.getProject(PREVIEW_DEMO_PROJECT_ID)).toBeUndefined();
  });
});
