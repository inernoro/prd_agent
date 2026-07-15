/**
 * 孤儿容器收割器单测（2026-07-15）。
 *
 * 锁四件事：
 *   1. 孤儿判定口径：cds-managed 容器的 owner（infra containerName / app branchId）
 *      不在 state → 孤儿 → stop；owner 在 state → 不碰；
 *   2. 安全阀：state 空库跳过、docker 查询失败跳过、env 逃生阀、
 *      系统级容器（cds-infra-cds-state-mongo）永不收割；
 *   3. 只停不删：已停止的孤儿记 already-stopped，不再发 docker 命令；
 *   4. 事件留痕：停止动作写 server-event。
 */
import { describe, it, expect } from 'vitest';
import { sweepOrphanCdsContainers, isOrphanReaperEnabled, processTeardownTombstones } from '../../src/services/orphan-container-reaper.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

function makeState(overrides: Partial<{
  projects: Array<{ id: string }>;
  branches: Array<{ id: string; services?: Record<string, { containerName?: string }> }>;
  infra: Array<{ containerName: string }>;
}> = {}) {
  return {
    getProjects: () => overrides.projects ?? [{ id: 'p1' }],
    getAllBranches: () => overrides.branches ?? [],
    getInfraServices: () => overrides.infra ?? [],
    getContainerTeardownTombstones: () => [],
    removeContainerTeardownTombstone: () => {},
  };
}

/** 可变墓碑 state stub：记录移除调用，供 processTeardownTombstones 断言。 */
function makeTombstoneState(items: Array<{ containerName: string; projectId: string; requestedAt: string }>) {
  let list = [...items];
  return {
    getContainerTeardownTombstones: () => [...list],
    removeContainerTeardownTombstone: (name: string) => { list = list.filter((t) => t.containerName !== name); },
    remaining: () => list.map((t) => t.containerName),
  };
}

// docker {{.CreatedAt}} 风格的时间戳：OLD 早于 30 分钟宽限期，NEW 在宽限期内
const OLD_CREATED = '2026-01-01 00:00:00 +0000 UTC';
const NEW_CREATED = new Date().toISOString();

function mockPs(shell: MockShellExecutor, infraLines: string[], appLines: string[]): void {
  shell.addResponsePattern(/cds\.type=infra/, () => ({ stdout: infraLines.join('\n'), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/cds\.type=app/, () => ({ stdout: appLines.join('\n'), stderr: '', exitCode: 0 }));
}

describe('isOrphanReaperEnabled', () => {
  it('defaults on; 0/false/off disable', () => {
    expect(isOrphanReaperEnabled({})).toBe(true);
    expect(isOrphanReaperEnabled({ CDS_ORPHAN_CONTAINER_REAPER: '1' })).toBe(true);
    for (const v of ['0', 'false', 'off']) {
      expect(isOrphanReaperEnabled({ CDS_ORPHAN_CONTAINER_REAPER: v })).toBe(false);
    }
  });
});

describe('sweepOrphanCdsContainers', () => {
  it('stops running orphan infra + app containers, spares known owners', async () => {
    const shell = new MockShellExecutor();
    mockPs(
      shell,
      [
        `cds-infra-known-mysql|running|${OLD_CREATED}|cds.managed=true,cds.type=infra,cds.service.id=mysql`,
        `cds-infra-ghost-redis|running|${OLD_CREATED}|cds.managed=true,cds.type=infra,cds.service.id=redis`,
      ],
      [
        `cds-live-api|running|${OLD_CREATED}|cds.managed=true,cds.type=app,cds.branch.id=live-branch,cds.profile.id=api`,
        `cds-ghost-api|running|${OLD_CREATED}|cds.managed=true,cds.type=app,cds.branch.id=deleted-branch,cds.profile.id=api`,
      ],
    );
    shell.addResponsePattern(/^docker stop /, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

    const events: unknown[] = [];
    const result = await sweepOrphanCdsContainers({
      shell,
      state: makeState({
        branches: [{ id: 'live-branch', services: { api: { containerName: 'cds-live-api' } } }],
        infra: [{ containerName: 'cds-infra-known-mysql' }],
      }),
      eventLog: { record: (e: unknown) => { events.push(e); } } as never,
      env: {},
    });

    expect(result.skippedReason).toBeUndefined();
    const stopped = result.actions.filter((a) => a.action === 'stopped').map((a) => a.containerName).sort();
    expect(stopped).toEqual(['cds-ghost-api', 'cds-infra-ghost-redis']);
    const stopCmds = shell.commands.filter((c) => c.startsWith('docker stop'));
    expect(stopCmds).toHaveLength(2);
    expect(stopCmds.join('\n')).not.toContain('known-mysql');
    expect(stopCmds.join('\n')).not.toContain('cds-live-api');
    expect(events).toHaveLength(2);
  });

  it('records already-stopped orphans without issuing docker commands', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell, [`cds-infra-ghost|exited|${OLD_CREATED}|cds.managed=true,cds.type=infra,cds.service.id=x`], []);
    const result = await sweepOrphanCdsContainers({ shell, state: makeState(), env: {} });
    expect(result.actions).toEqual([
      { containerName: 'cds-infra-ghost', kind: 'infra', ownerHint: undefined, action: 'already-stopped' },
    ]);
    expect(shell.commands.filter((c) => c.startsWith('docker stop'))).toHaveLength(0);
  });

  it('never touches the protected system state-mongo container', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell, [`cds-infra-cds-state-mongo|running|${OLD_CREATED}|cds.managed=true,cds.type=infra,cds.service.id=cds-state-mongo`], []);
    shell.addResponsePattern(/^docker stop /, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    // state 里故意不登记它 —— 即便如此也不许收割
    const result = await sweepOrphanCdsContainers({ shell, state: makeState(), env: {} });
    expect(result.actions).toEqual([]);
    expect(shell.commands.filter((c) => c.startsWith('docker stop'))).toHaveLength(0);
  });

  it('skips entirely when state looks empty (load failure / fresh install guard)', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell, [`cds-infra-ghost|running|${OLD_CREATED}|cds.managed=true,cds.type=infra,cds.service.id=x`], []);
    const result = await sweepOrphanCdsContainers({
      shell,
      state: makeState({ projects: [], branches: [], infra: [] }),
      env: {},
    });
    expect(result.skippedReason).toBe('state-empty');
    expect(shell.commands).toHaveLength(0);
  });

  it('skips when the docker query fails (never act on partial information)', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/cds\.type=infra/, () => ({ stdout: '', stderr: 'docker daemon down', exitCode: 1 }));
    shell.addResponsePattern(/cds\.type=app/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const result = await sweepOrphanCdsContainers({ shell, state: makeState(), env: {} });
    expect(result.skippedReason).toBe('docker-query-failed');
    expect(shell.commands.filter((c) => c.startsWith('docker stop'))).toHaveLength(0);
  });

  it('is disabled via CDS_ORPHAN_CONTAINER_REAPER=0', async () => {
    const shell = new MockShellExecutor();
    const result = await sweepOrphanCdsContainers({
      shell,
      state: makeState(),
      env: { CDS_ORPHAN_CONTAINER_REAPER: '0' },
    });
    expect(result.skippedReason).toBe('disabled');
    expect(shell.commands).toHaveLength(0);
  });

  it('reaps a stale container whose profile was removed from a live branch (pair matching)', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell, [], [
      `cds-live-api|running|${OLD_CREATED}|cds.managed=true,cds.type=app,cds.branch.id=live-branch,cds.profile.id=api`,
      `cds-live-old-worker|running|${OLD_CREATED}|cds.managed=true,cds.type=app,cds.branch.id=live-branch,cds.profile.id=worker`,
    ]);
    shell.addResponsePattern(/^docker stop /, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const result = await sweepOrphanCdsContainers({
      shell,
      state: makeState({ branches: [{ id: 'live-branch', services: { api: { containerName: 'cds-live-api' } } }] }),
      env: {},
    });
    const stopped = result.actions.filter((a) => a.action === 'stopped').map((a) => a.containerName);
    expect(stopped).toEqual(['cds-live-old-worker']);
  });

  it('spares a label-mismatched container that state still references by name', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell, [], [
      `cds-live-api|running|${OLD_CREATED}|cds.managed=true,cds.type=app,cds.branch.id=renamed-branch,cds.profile.id=api`,
    ]);
    shell.addResponsePattern(/^docker stop /, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const result = await sweepOrphanCdsContainers({
      shell,
      state: makeState({ branches: [{ id: 'live-branch', services: { api: { containerName: 'cds-live-api' } } }] }),
      env: {},
    });
    expect(result.actions).toEqual([]);
  });

  it('leaves freshly created containers alone (grace period covers mid-deploy windows)', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell,
      [`cds-infra-young|running|${NEW_CREATED}|cds.managed=true,cds.type=infra,cds.service.id=y`],
      [`cds-young-api|running|${NEW_CREATED}|cds.managed=true,cds.type=app,cds.branch.id=brand-new,cds.profile.id=api`],
    );
    shell.addResponsePattern(/^docker stop /, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const result = await sweepOrphanCdsContainers({ shell, state: makeState(), env: {} });
    expect(result.actions).toEqual([]);
    expect(shell.commands.filter((c) => c.startsWith('docker stop'))).toHaveLength(0);
  });

  it('treats unparseable CreatedAt as within grace (never act on partial information)', async () => {
    const shell = new MockShellExecutor();
    mockPs(shell, ['cds-infra-ghost|running|not-a-date|cds.managed=true,cds.type=infra,cds.service.id=x'], []);
    const result = await sweepOrphanCdsContainers({ shell, state: makeState(), env: {} });
    expect(result.actions).toEqual([]);
  });
});

describe('processTeardownTombstones', () => {
  const T = (name: string) => ({ containerName: name, projectId: 'dead-project', requestedAt: '2026-07-15T10:00:00.000Z' });

  it('removes containers older than the tombstone and clears the tombstone', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker inspect -f /, () => ({ stdout: '2026-07-15T09:00:00.000000000Z', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker rm -f /, () => ({ stdout: 'removed', stderr: '', exitCode: 0 }));
    const state = makeTombstoneState([T('cds-dead-api')]);
    const result = await processTeardownTombstones({ shell, state });
    expect(result.removed).toEqual(['cds-dead-api']);
    expect(state.remaining()).toEqual([]);
  });

  it('spares a same-name container created after the tombstone (project recreated)', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker inspect -f /, () => ({ stdout: '2026-07-15T11:00:00.000000000Z', stderr: '', exitCode: 0 }));
    const state = makeTombstoneState([T('cds-reborn-api')]);
    const result = await processTeardownTombstones({ shell, state });
    expect(result.superseded).toEqual(['cds-reborn-api']);
    expect(state.remaining()).toEqual([]);
    expect(shell.commands.filter((c) => c.startsWith('docker rm'))).toHaveLength(0);
  });

  it('clears the tombstone when the container is already gone', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker inspect -f /, () => ({ stdout: '', stderr: 'Error: No such object: cds-gone', exitCode: 1 }));
    const state = makeTombstoneState([T('cds-gone')]);
    const result = await processTeardownTombstones({ shell, state });
    expect(result.removed).toEqual(['cds-gone']);
    expect(state.remaining()).toEqual([]);
  });

  it('keeps the tombstone for retry when docker is unavailable', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker inspect -f /, () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }));
    const state = makeTombstoneState([T('cds-dead-api')]);
    const result = await processTeardownTombstones({ shell, state });
    expect(result.pending).toEqual(['cds-dead-api']);
    expect(state.remaining()).toEqual(['cds-dead-api']);
  });

  it('is retried by the sweep even when scan-state is empty (last-project delete)', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker inspect -f /, () => ({ stdout: '2026-07-15T09:00:00.000000000Z', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker rm -f /, () => ({ stdout: 'removed', stderr: '', exitCode: 0 }));
    const tomb = makeTombstoneState([T('cds-last-project-api')]);
    const state = {
      getProjects: () => [],
      getAllBranches: () => [],
      getInfraServices: () => [],
      getContainerTeardownTombstones: tomb.getContainerTeardownTombstones,
      removeContainerTeardownTombstone: tomb.removeContainerTeardownTombstone,
    };
    const result = await sweepOrphanCdsContainers({ shell, state, env: {} });
    // 扫描式判定仍被空库守卫拦住，但墓碑补偿已经执行
    expect(result.skippedReason).toBe('state-empty');
    expect(tomb.remaining()).toEqual([]);
    expect(shell.commands.some((c) => c.startsWith('docker rm -f'))).toBe(true);
  });
});
