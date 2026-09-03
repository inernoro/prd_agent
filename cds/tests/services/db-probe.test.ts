/**
 * 库探测（收敛 0「可信数据面」）：用户看到的必须是实测库名，不是配置推断。
 *
 * 钉住四件事：
 *   1. 判定是纯函数：容器 env 的库名 ≠ 配置折算的库名 → mismatch，原因写「容器未按当前配置重新部署」；
 *      容器不在跑 → not-running；实测失败 → probe-failed 且带失败原因（不是拿配置值冒充实测）；
 *      连上的库 ≠ 容器 env 写的库 → mismatch，原因指向连接串未跟随。
 *   2. 实测走**应用自己的凭据**（拍板 A）：从应用容器的连接串取 user/pw，不用基础设施 root；
 *      只有应用 env 里根本没凭据时才退回 root，并如实标注凭据来源。
 *   3. 报告里不泄露密码；每个值都带探测时间。
 *   4. 探测本身不写库：只发 SELECT / db.getName 一类只读语句。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import {
  judgeDbProbe,
  probeBranchDb,
  type DbProbeConfigured,
  type DbProbeContainer,
  type DbProbeLive,
  type DbProbeExec,
} from '../../src/services/db-probe.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchEntry, BuildProfile, InfraService } from '../../src/types.js';

const NOW = '2026-09-03T08:00:00.000Z';
const APP_PW = 'S3cretAppPw';
const ROOT_PW = 'RootPwNeverShown';

function configured(o: Partial<DbProbeConfigured> = {}): DbProbeConfigured {
  return {
    dbScope: 'per-branch', dbScopeSource: 'baseline', engine: 'mysql',
    dbName: 'app_feat_x', envKeys: ['CDS_MYSQL_DATABASE'], infraId: 'mysql', ...o,
  };
}
function container(o: Partial<DbProbeContainer> = {}): DbProbeContainer {
  return { containerName: 'cds-proj-feat-api', status: 'running', running: true, dbName: 'app_feat_x', inspectedAt: NOW, ...o };
}
function live(o: Partial<DbProbeLive> = {}): DbProbeLive {
  return {
    attempted: true, ok: true, currentDb: 'app_feat_x', serverVersion: '8.0.36', objectCount: 12,
    credentialSource: 'app-url', probedAt: NOW, ...o,
  };
}

describe('judgeDbProbe：判定是纯函数，原因必须说人话', () => {
  it('三者一致 → match', () => {
    expect(judgeDbProbe(configured(), container(), live())).toEqual({ verdict: 'match', reasons: [] });
  });

  it('容器 env 的库名 ≠ 配置折算的库名 → mismatch，原因写「容器未按当前配置重新部署」', () => {
    const r = judgeDbProbe(configured({ dbScope: 'shared', dbName: 'app' }), container({ dbName: 'app_feat_x' }), live());
    expect(r.verdict).toBe('mismatch');
    expect(r.reasons.join('\n')).toContain('容器实际持有 app_feat_x');
    expect(r.reasons.join('\n')).toContain('配置说的是 app');
    expect(r.reasons.join('\n')).toContain('容器未按当前配置重新部署');
  });

  it('容器没在跑 → not-running，不拿配置值冒充实测', () => {
    const r = judgeDbProbe(configured(), container({ status: 'exited', running: false, dbName: null }), live({ attempted: false, ok: false, currentDb: null }));
    expect(r.verdict).toBe('not-running');
    expect(r.reasons[0]).toContain('exited');
    expect(r.reasons[0]).toContain('无法实测');
  });

  it('容器不存在 → not-running，原因说明容器缺失', () => {
    const r = judgeDbProbe(configured(), container({ containerName: null, status: 'missing', running: false, dbName: null }), live({ attempted: false, ok: false, currentDb: null }));
    expect(r.verdict).toBe('not-running');
    expect(r.reasons[0]).toContain('还没有容器');
  });

  it('实测失败 → probe-failed，带失败原因', () => {
    const r = judgeDbProbe(configured(), container(), live({ ok: false, currentDb: null, error: 'Access denied for user app' }));
    expect(r.verdict).toBe('probe-failed');
    expect(r.reasons[0]).toContain('Access denied for user app');
  });

  it('连上的库 ≠ 容器 env 写的库 → mismatch，原因指向连接串未跟随', () => {
    const r = judgeDbProbe(configured(), container(), live({ currentDb: 'app' }));
    expect(r.verdict).toBe('mismatch');
    expect(r.reasons.join('\n')).toContain('连上的库是 app');
    expect(r.reasons.join('\n')).toContain('连接串');
  });

  it('配置里定位不到库 → no-db，原因来自定位器', () => {
    const r = judgeDbProbe(
      configured({ engine: null, dbName: null, envKeys: [], infraId: null, reason: '该服务的环境变量里没有数据库名' }),
      container(), live({ attempted: false, ok: false, currentDb: null }),
    );
    expect(r.verdict).toBe('no-db');
    expect(r.reasons[0]).toContain('没有数据库名');
  });
});

describe('probeBranchDb：docker inspect 容器真身 + 应用凭据实测', () => {
  let tmpDir: string;
  let state: StateService;
  let calls: string[][];
  let containerEnv: string[] | null;
  let containerStatus: string;
  let liveStdout: string;
  let liveCode: number;

  const exec: DbProbeExec = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'inspect') {
      if (!containerEnv) return { code: 1, stdout: '', stderr: 'Error: No such object', truncated: false };
      return { code: 0, stdout: `${containerStatus}\t${JSON.stringify(containerEnv)}\n`, stderr: '', truncated: false };
    }
    if (argv[0] === 'exec') {
      return { code: liveCode, stdout: liveStdout, stderr: liveCode === 0 ? '' : liveStdout, truncated: false };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}`, truncated: false };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-db-probe-'));
    state = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    state.load();
    state.addProject({ id: 'proj', slug: 'proj', name: 'proj', kind: 'git', createdAt: NOW, updatedAt: NOW } as any);
    state.addBuildProfile({
      id: 'api', projectId: 'proj', name: 'API', dockerImage: 'node:20', workDir: '.', containerPort: 3000,
      dbScope: 'per-branch',
      env: { CDS_MYSQL_DATABASE: 'app', DATABASE_URL: `mysql://app:${APP_PW}@cds-infra-mysql:3306/app` },
    } as BuildProfile);
    state.addBuildProfile({
      id: 'web', projectId: 'proj', name: 'Web', dockerImage: 'nginx:alpine', workDir: '.', containerPort: 80,
    } as BuildProfile);
    state.addInfraService({
      id: 'mysql', name: 'mysql', projectId: 'proj', scope: 'project', dockerImage: 'mysql:8',
      containerName: 'cds-infra-mysql', hostPort: 13306, containerPort: 3306, status: 'running',
      env: { MYSQL_ROOT_PASSWORD: ROOT_PW },
    } as unknown as InfraService);
    state.addBranch({
      id: 'proj-feat-x', projectId: 'proj', branch: 'feat/x', worktreePath: path.join(tmpDir, 'wt'),
      status: 'running', createdAt: NOW,
      services: {
        api: { profileId: 'api', containerName: 'cds-proj-feat-x-api', hostPort: 40001, status: 'running' },
      },
    } as unknown as BranchEntry);
    state.save();
    calls = [];
    containerStatus = 'running';
    containerEnv = ['CDS_MYSQL_DATABASE=app_feat_x', `DATABASE_URL=mysql://app:${APP_PW}@cds-infra-mysql:3306/app_feat_x`, 'PORT=3000'];
    liveStdout = 'app_feat_x\t8.0.36\t12\n';
    liveCode = 0;
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('一切一致：配置说的、容器持有的、连上的三者同名 → match，带版本、表数、探测时间', async () => {
    const report = await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW) });
    expect(report.branchId).toBe('proj-feat-x');
    const api = report.services.find((s) => s.profileId === 'api')!;
    expect(api.verdict).toBe('match');
    expect(api.configured).toMatchObject({ dbScope: 'per-branch', dbScopeSource: 'baseline', engine: 'mysql', dbName: 'app_feat_x', infraId: 'mysql' });
    expect(api.container).toMatchObject({ containerName: 'cds-proj-feat-x-api', running: true, dbName: 'app_feat_x', inspectedAt: NOW });
    expect(api.live).toMatchObject({ ok: true, currentDb: 'app_feat_x', serverVersion: '8.0.36', objectCount: 12, credentialSource: 'app-url', probedAt: NOW });
    expect(report.probedAt).toBe(NOW);
    // 没声明库名变量的服务如实标 no-db，而不是缺席
    const web = report.services.find((s) => s.profileId === 'web')!;
    expect(web.verdict).toBe('no-db');
    expect(report.summary).toMatchObject({ services: 2, match: 1, noDb: 1 });
  });

  it('实测走应用自己的凭据（拍板 A）：mysql 客户端用 app 用户、密码进 env 不进 argv，且不用 root', async () => {
    await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW), profileId: 'api' });
    const execCall = calls.find((c) => c[0] === 'exec')!;
    expect(execCall, '应当在基础设施容器里起一次 mysql 客户端').toBeTruthy();
    expect(execCall).toContain('cds-infra-mysql');
    expect(execCall).toContain('-uapp');
    expect(execCall).toContain(`MYSQL_PWD=${APP_PW}`);
    expect(execCall.join(' ')).not.toContain(ROOT_PW);
    expect(execCall.join(' ')).not.toContain('-uroot');
    // 只读：只发 SELECT
    const sql = execCall[execCall.lastIndexOf('-e') + 1];
    expect(sql).toMatch(/^SELECT /i);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|DROP/i);
  });

  it('旧容器没重新部署：容器 env 还是共享库名 → mismatch，原因写「容器未按当前配置重新部署」', async () => {
    containerEnv = ['CDS_MYSQL_DATABASE=app', `DATABASE_URL=mysql://app:${APP_PW}@cds-infra-mysql:3306/app`];
    liveStdout = 'app\t8.0.36\t40\n';
    const report = await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW), profileId: 'api' });
    const api = report.services[0];
    expect(api.verdict).toBe('mismatch');
    expect(api.configured.dbName).toBe('app_feat_x');
    expect(api.container.dbName).toBe('app');
    expect(api.reasons.join('\n')).toContain('容器未按当前配置重新部署');
    // 实测列展示的是容器真的连着的库，不是配置值
    expect(api.live.currentDb).toBe('app');
  });

  it('容器不存在 → not-running，不发任何实测命令', async () => {
    containerEnv = null;
    const report = await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW), profileId: 'api' });
    expect(report.services[0].verdict).toBe('not-running');
    expect(report.services[0].container.running).toBe(false);
    expect(calls.some((c) => c[0] === 'exec')).toBe(false);
  });

  it('实测失败 → probe-failed，失败原因原样带出（脱敏），实测列不显示配置值', async () => {
    liveCode = 1;
    liveStdout = `ERROR 1045 (28000): Access denied for user 'app'@'%' (using password: YES)`;
    const report = await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW), profileId: 'api' });
    const api = report.services[0];
    expect(api.verdict).toBe('probe-failed');
    expect(api.live.ok).toBe(false);
    expect(api.live.currentDb).toBeNull();
    expect(api.live.error).toContain('Access denied');
  });

  it('应用 env 里没有任何凭据时才退回基础设施 root，并如实标注 credentialSource=infra-root', async () => {
    containerEnv = ['CDS_MYSQL_DATABASE=app_feat_x', 'MYSQL_HOST=cds-infra-mysql'];
    const report = await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW), profileId: 'api' });
    expect(report.services[0].live.credentialSource).toBe('infra-root');
    const execCall = calls.find((c) => c[0] === 'exec')!;
    expect(execCall).toContain('-uroot');
  });

  it('报告 JSON 不泄露密码', async () => {
    const report = await probeBranchDb(state, 'proj-feat-x', { exec, now: () => new Date(NOW) });
    const json = JSON.stringify(report);
    expect(json).not.toContain(APP_PW);
    expect(json).not.toContain(ROOT_PW);
  });

  it('分支不存在 → 抛错', async () => {
    await expect(probeBranchDb(state, 'nope', { exec })).rejects.toThrow('分支不存在');
  });
});
