import { afterEach, describe, expect, it } from 'vitest';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import {
  DEFAULT_WORKLOAD_SLICE,
  __setWorkloadCgroupForTest,
  getWorkloadCgroupStatus,
  planWorkloadCgroup,
  resolveWorkloadCgroup,
  workloadCgroupArgv,
  workloadCgroupFlags,
  workloadCgroupParentFromEnv,
} from '../../src/services/workload-cgroup.js';

/**
 * 托管容器 cgroup 归属（2026-09-08 宿主过载复盘）。
 * 契约：不给容器设上限，只在争抢时让 CDS 控制面先拿——所以这里只断言
 * 「挂到哪个 slice、什么情况下不挂」，绝不出现 --cpus / --memory。
 */
describe('workload-cgroup 托管容器归属', () => {
  afterEach(() => {
    __setWorkloadCgroupForTest(null);
  });

  it('env 未设时默认挂 system-cdsworkloads.slice；0/off 关闭；自定义值原样透传', () => {
    expect(workloadCgroupParentFromEnv({})).toBe(DEFAULT_WORKLOAD_SLICE);
    expect(workloadCgroupParentFromEnv({ CDS_WORKLOAD_CGROUP_PARENT: '' })).toBe(DEFAULT_WORKLOAD_SLICE);
    expect(workloadCgroupParentFromEnv({ CDS_WORKLOAD_CGROUP_PARENT: '0' })).toBeNull();
    expect(workloadCgroupParentFromEnv({ CDS_WORKLOAD_CGROUP_PARENT: 'off' })).toBeNull();
    expect(workloadCgroupParentFromEnv({ CDS_WORKLOAD_CGROUP_PARENT: 'my.slice' })).toBe('my.slice');
  });

  it('systemd driver + slice 名 → 启用且权重由 systemd 接管', () => {
    const s = planWorkloadCgroup(DEFAULT_WORKLOAD_SLICE, 'systemd');
    expect(s).toMatchObject({ enabled: true, parent: DEFAULT_WORKLOAD_SLICE, weightManaged: true });
  });

  it('systemd driver 但值不是 .slice → 不追加（docker 会拒绝非 slice 名）', () => {
    const s = planWorkloadCgroup('/cds-workloads', 'systemd');
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('.slice');
  });

  it('cgroupfs driver → 归到路径但明说权重未接管', () => {
    const s = planWorkloadCgroup(DEFAULT_WORKLOAD_SLICE, 'cgroupfs');
    expect(s).toMatchObject({ enabled: true, parent: '/cdsworkloads', weightManaged: false });
    expect(s.reason).toContain('权重');
  });

  /**
   * Codex 六轮 P2：这个值来自运维配置，会被拼进宿主 shell 的 docker 命令行。
   * 一个空格让此后所有部署的命令行错位，一个分号就是宿主上的另一条命令。
   * 字符集拒收 + 拼串时加引号，两道都要。
   */
  it('含 shell 元字符或空白的配置值一律拒收，不进 docker 命令行', () => {
    for (const bad of [
      'system-cds.slice; rm -rf /',
      'system cds.slice',
      'system-cds.slice$(id)',
      'system-cds.slice`id`',
      "system-cds.slice'",
      'system-cds.slice\n',
      'system-cds.slice|tee',
    ]) {
      const s = planWorkloadCgroup(bad, 'systemd');
      expect(s.enabled, bad).toBe(false);
      expect(s.reason, bad).toContain('非法字符');
      __setWorkloadCgroupForTest(s);
      expect(workloadCgroupFlags(), bad).toEqual([]);
      expect(workloadCgroupArgv(), bad).toEqual([]);
    }
  });

  it('合法的自定义 slice 名照常生效，且拼串形态带引号', () => {
    const s = planWorkloadCgroup('my-workloads.slice', 'systemd');
    expect(s).toMatchObject({ enabled: true, parent: 'my-workloads.slice', weightManaged: true });
    __setWorkloadCgroupForTest(s);
    expect(workloadCgroupFlags()).toEqual(["--cgroup-parent 'my-workloads.slice'"]);
    // argv 形态不经 shell，原样传
    expect(workloadCgroupArgv()).toEqual(['--cgroup-parent', 'my-workloads.slice']);
  });

  it('driver 未知 / 关闭 / 预览实例 一律不追加', () => {
    expect(planWorkloadCgroup(DEFAULT_WORKLOAD_SLICE, 'unknown').enabled).toBe(false);
    expect(planWorkloadCgroup(null, 'systemd').enabled).toBe(false);
    expect(planWorkloadCgroup(DEFAULT_WORKLOAD_SLICE, 'systemd', { previewInstance: true }).enabled).toBe(false);
  });

  it('resolveWorkloadCgroup 走一次 docker info 探测并固化决策', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker info/, () => ({ stdout: 'systemd\n', stderr: '', exitCode: 0 }));
    const s = await resolveWorkloadCgroup(shell, {});
    expect(s.enabled).toBe(true);
    expect(getWorkloadCgroupStatus()).toEqual(s);
    expect(workloadCgroupFlags()).toEqual([`--cgroup-parent '${DEFAULT_WORKLOAD_SLICE}'`]);
    expect(workloadCgroupArgv()).toEqual(['--cgroup-parent', DEFAULT_WORKLOAD_SLICE]);
    expect(shell.commands.filter((c) => c.includes('docker info'))).toHaveLength(1);
  });

  it('docker info 失败时安全退化为不追加，且 flags 为空', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker info/, () => ({ stdout: '', stderr: 'Cannot connect', exitCode: 1 }));
    const s = await resolveWorkloadCgroup(shell, {});
    expect(s.enabled).toBe(false);
    expect(workloadCgroupFlags()).toEqual([]);
    expect(workloadCgroupArgv()).toEqual([]);
  });

  it('预览实例 env 下不探测 docker、不追加', async () => {
    const shell = new MockShellExecutor();
    const s = await resolveWorkloadCgroup(shell, { CDS_PREVIEW_INSTANCE: '1' });
    expect(s.enabled).toBe(false);
    expect(shell.commands).toHaveLength(0);
  });
});
