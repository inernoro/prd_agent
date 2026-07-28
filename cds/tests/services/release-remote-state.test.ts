import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReleaseService,
  type ReleaseSshExecutor,
} from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseRun, ReleaseStrategy, ReleaseTarget } from '../../src/types.js';

/**
 * 远端现场读回与回收的接线回归（注入假 SSH 执行器，不需要真 sshd）。
 *
 * 事故值（本文件守的是「回收把生产删了」这一类）：
 *  - 只读路径若混进任何写命令，一次纯运维的「看一眼线上是哪版」就能改动生产；
 *  - 探测失败后的自动恢复目录 `rel_xxxx-auto-restore` 从未进过台账，却完全可能是
 *    current 指向的那一份。先按台账算再删，第一刀就砍掉线上正在服务的目录；
 *  - 在途发布期间回收 = 和执行体抢同一棵 worktree；
 *  - 目标不可达时若把异常抛出去，一台机器不通会拖垮整轮巡检乃至发布主流程。
 */

const ONLINE_RUN = 'rel_00000000000000aa';
const OLD_RUN = 'rel_00000000000000bb';
const STALE_RUN = 'rel_00000000000000cc';

const COMPOSE_STRATEGY: ReleaseStrategy = {
  mode: 'generated-compose',
  composeFile: 'cds-compose.yml',
  composeProject: 'p1-prod',
};

function releaseTarget(strategy: ReleaseStrategy = COMPOSE_STRATEGY): ReleaseTarget {
  return {
    id: 'target-prod',
    projectId: 'p1',
    name: '生产站点',
    type: 'ssh',
    createdAt: '2026-07-28T00:00:00.000Z',
    isEnabled: true,
    strategy,
    ssh: {
      host: '127.0.0.1',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-prod',
      appPath: '/opt/app-prod/current',
      deployCommand: './deploy.sh',
      healthcheckUrl: 'https://app.example.test/healthz',
    },
  };
}

function releaseRun(releaseId: string, startedAt: string, patch: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    releaseId,
    projectId: 'p1',
    branchId: 'b1',
    commitSha: '9'.repeat(40),
    artifact: { type: 'branch-preview', commitSha: '9'.repeat(40), branchId: 'b1', branchName: 'main' },
    targetId: 'target-prod',
    planId: 'p1:generated-compose',
    status: 'success',
    startedAt,
    finishedAt: startedAt,
    logs: [],
    seq: 0,
    ...patch,
  };
}

/** 一次盘点的假输出。current/previous 是绝对路径，worktrees 是 basename。 */
function inventoryStdout(options: { current: string; previous?: string; worktrees: string[] }): string {
  const root = '/opt/.cds-releases/target-prod';
  return [
    `CDS_RELEASE_ROOT=${root}`,
    `CDS_RELEASE_WORKTREE_ROOT=${root}/worktrees`,
    `CDS_RELEASE_CURRENT=${root}/worktrees/${options.current}`,
    `CDS_RELEASE_PREVIOUS=${options.previous ? `${root}/worktrees/${options.previous}` : ''}`,
    ...options.worktrees.map((name) => `CDS_RELEASE_WORKTREE=${name}`),
  ].join('\n');
}

function isWriteCommand(command: string): boolean {
  return /worktree remove|worktree prune|rm -rf|ln -s|docker compose|git .*fetch/.test(command);
}

describe('远端发布现场读回与回收', () => {
  let stateDir: string;
  let stateService: StateService;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-remote-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
    stateService.addRemoteHost({
      id: 'host-prod',
      name: '生产主机',
      host: '127.0.0.1',
      sshPort: 22,
      sshUser: 'deploy',
      sshPrivateKeyEncrypted: 'PLAINTEXT-TEST-KEY',
      sshPrivateKeyFingerprint: 'deadbeefdeadbeef',
      tags: [],
      isEnabled: true,
      createdAt: '2026-07-28T00:00:00.000Z',
    } as never);
    stateService.upsertReleaseTarget(releaseTarget());
  });

  afterEach(async () => {
    await stateService.flush();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function createService(respond: (command: string) => string | Promise<string>): {
    service: ReleaseService;
    commands: string[];
  } {
    const commands: string[] = [];
    const sshExecutor: ReleaseSshExecutor = async (req) => {
      commands.push(req.command);
      return respond(req.command);
    };
    return { service: new ReleaseService(stateService, { sshExecutor }), commands };
  }

  it('读回远端现场只发只读命令，一条写命令都不发', async () => {
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    const { service, commands } = createService(() => inventoryStdout({ current: ONLINE_RUN, worktrees: [ONLINE_RUN] }));

    const state = await service.readRemoteReleaseState(stateService.getReleaseTarget('target-prod')!);

    expect(state.drift.status).toBe('in-sync');
    expect(commands).toHaveLength(1);
    expect(commands.some(isWriteCommand)).toBe(false);
  });

  it('目标不可达时安全失败：判 unknown，不抛异常', async () => {
    const { service } = createService(() => { throw new Error('ECONNREFUSED 127.0.0.1:22'); });

    const state = await service.readRemoteReleaseState(stateService.getReleaseTarget('target-prod')!);

    expect(state.drift.status).toBe('unknown');
    expect(state.readError).toContain('ECONNREFUSED');
  });

  it('existing-script 目标不打 SSH，直接判「不适用」', async () => {
    stateService.upsertReleaseTarget(releaseTarget({ mode: 'existing-script', command: './deploy.sh' }));
    const { service, commands } = createService(() => '');

    const state = await service.readRemoteReleaseState(stateService.getReleaseTarget('target-prod')!);

    expect(state.drift.status).toBe('not-applicable');
    expect(commands).toEqual([]);
  });

  it('回收超期 worktree，但绝不碰 current / previous 指向的两份', async () => {
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    const { service, commands } = createService((command) => (
      isWriteCommand(command)
        ? ''
        : inventoryStdout({ current: ONLINE_RUN, previous: OLD_RUN, worktrees: [ONLINE_RUN, OLD_RUN, STALE_RUN] })
    ));

    const result = await service.reclaimRemoteReleaseArtifacts(
      stateService.getReleaseTarget('target-prod')!,
      { maxRemovals: 10 },
    );

    expect(result.removedWorktrees).toEqual([STALE_RUN]);
    expect(result.keptReasons[ONLINE_RUN]).toContain('current');
    expect(result.keptReasons[OLD_RUN]).toContain('previous');
    const deletion = commands.find(isWriteCommand)!;
    expect(deletion).toContain(`'${STALE_RUN}'`);
    expect(deletion).not.toContain(ONLINE_RUN);
    expect(deletion).not.toContain(OLD_RUN);
  });

  it('current 指向自动恢复目录时同样保住——它从未进过台账', async () => {
    // 事故值：台账里只有 ONLINE_RUN，`${STALE_RUN}-auto-restore` 查无此人；
    // 只按台账保护会把线上正在服务的目录当成陌生残留删掉。
    const restore = `${STALE_RUN}-auto-restore`;
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    stateService.addReleaseRun(releaseRun(STALE_RUN, '2026-07-28T04:00:00.000Z', {
      status: 'failed',
      previousReleaseId: ONLINE_RUN,
    }));
    const { service, commands } = createService((command) => (
      isWriteCommand(command)
        ? ''
        : inventoryStdout({ current: restore, worktrees: [ONLINE_RUN, STALE_RUN, restore] })
    ));

    const result = await service.reclaimRemoteReleaseArtifacts(
      stateService.getReleaseTarget('target-prod')!,
      { maxRemovals: 10 },
    );

    expect(result.drift.status).toBe('in-sync');
    expect(result.removedWorktrees).not.toContain(restore);
    expect(commands.filter(isWriteCommand).join('\n')).not.toContain(restore);
  });

  it('目标上有在途 run 时整轮不删', async () => {
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    stateService.addReleaseRun(releaseRun(STALE_RUN, '2026-07-28T04:00:00.000Z', { status: 'running', finishedAt: undefined }));
    const { service, commands } = createService((command) => (
      isWriteCommand(command) ? '' : inventoryStdout({ current: ONLINE_RUN, worktrees: [ONLINE_RUN, OLD_RUN] })
    ));

    const result = await service.reclaimRemoteReleaseArtifacts(stateService.getReleaseTarget('target-prod')!);

    expect(result.removedWorktrees).toEqual([]);
    expect(result.skippedReason).toContain('进行中');
    expect(commands.some(isWriteCommand)).toBe(false);
  });

  it('run 已终态但执行体没退出时也不删——回收走的是同一道并发闸', async () => {
    // 事故值：只看台账的 isReleaseRunInFlight，会漏掉「刚被取消、SSH 还在飞」这一档；
    // 那条 SSH 可能正在写 worktree，此刻回收就是两个进程抢同一棵树。
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    stateService.addReleaseRun(releaseRun(STALE_RUN, '2026-07-28T04:00:00.000Z', { status: 'failed' }));
    const { service, commands } = createService((command) => (
      isWriteCommand(command) ? '' : inventoryStdout({ current: ONLINE_RUN, worktrees: [ONLINE_RUN, STALE_RUN] })
    ));
    (service as unknown as { inFlight: Map<string, unknown> }).inFlight
      .set(STALE_RUN, { controller: new AbortController() });

    const result = await service.reclaimRemoteReleaseArtifacts(stateService.getReleaseTarget('target-prod')!);

    expect(result.removedWorktrees).toEqual([]);
    expect(result.skippedReason).toContain('进行中');
    expect(commands.some(isWriteCommand)).toBe(false);
  });

  it('读不回来时整轮不删，不把「看不见」当成「没有产物」', async () => {
    const { service, commands } = createService(() => { throw new Error('EHOSTUNREACH'); });

    const result = await service.reclaimRemoteReleaseArtifacts(stateService.getReleaseTarget('target-prod')!);

    expect(result.removedWorktrees).toEqual([]);
    // 读不回来先落成 unknown 漂移，再被漂移闸拦下；两道闸都指向同一件事：看不见就不动手。
    expect(result.skippedReason).toContain('unknown');
    expect(result.readError).toContain('EHOSTUNREACH');
    expect(commands.some(isWriteCommand)).toBe(false);
  });

  it('远端漂移时整轮不删——回收等于毁灭现场证据', async () => {
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    const { service, commands } = createService((command) => (
      isWriteCommand(command) ? '' : inventoryStdout({ current: STALE_RUN, worktrees: [ONLINE_RUN, STALE_RUN, OLD_RUN] })
    ));

    const result = await service.reclaimRemoteReleaseArtifacts(stateService.getReleaseTarget('target-prod')!);

    expect(result.drift.status).toBe('drifted');
    expect(result.removedWorktrees).toEqual([]);
    expect(commands.some(isWriteCommand)).toBe(false);
  });

  it('删除命令失败不抛异常，产物留着下一轮再收', async () => {
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    const { service } = createService((command) => {
      if (isWriteCommand(command)) throw new Error('ssh exec exit=1');
      return inventoryStdout({ current: ONLINE_RUN, worktrees: [ONLINE_RUN, STALE_RUN] });
    });

    const result = await service.reclaimRemoteReleaseArtifacts(stateService.getReleaseTarget('target-prod')!);

    expect(result.removedWorktrees).toEqual([]);
    expect(result.skippedReason).toContain('回收命令执行失败');
  });

  it('dry-run 报出本来会删哪些，但一条写命令都不发', async () => {
    stateService.addReleaseRun(releaseRun(ONLINE_RUN, '2026-07-28T03:00:00.000Z'));
    const { service, commands } = createService(() => inventoryStdout({
      current: ONLINE_RUN,
      worktrees: [ONLINE_RUN, STALE_RUN],
    }));

    const result = await service.reclaimRemoteReleaseArtifacts(
      stateService.getReleaseTarget('target-prod')!,
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.removedWorktrees).toEqual([STALE_RUN]);
    expect(commands.some(isWriteCommand)).toBe(false);
  });
});
