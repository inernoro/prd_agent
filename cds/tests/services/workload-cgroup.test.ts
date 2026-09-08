import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import {
  DEFAULT_WORKLOAD_SLICE,
  __setWorkloadCgroupForTest,
  getWorkloadCgroupStatus,
  isControlPlanePrioritized,
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
/**
 * 接线守卫：这条探测在 index.ts 的启动路径上，没有任何用例会因为它被删掉或被条件
 * 包住而变红（形状 2）。八轮 review 抓到的正是这种静默退化——探测原先被
 * `config.mode !== 'executor'` 包着，于是 executor 节点在自己那台宿主上跑的构建
 * 与容器全都拿不到低权重分组，而它们照样和 executor API 抢 CPU。
 * 跳过预览实例的判断在 resolveWorkloadCgroup 内部做，调用点不该再加模式条件。
 */
describe('workload-cgroup 启动接线', () => {
  const indexSource = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'),
    'utf8',
  );

  it('index.ts 无条件调用 resolveWorkloadCgroup，不按运行模式跳过', () => {
    const at = indexSource.indexOf('await resolveWorkloadCgroup(');
    expect(at, '启动路径上找不到 resolveWorkloadCgroup 调用').toBeGreaterThan(-1);
    // 调用点上方这一段里不该出现按模式跳过的分支
    const preceding = indexSource.slice(Math.max(0, at - 600), at);
    expect(preceding).not.toMatch(/mode\s*!==\s*'executor'/);
    expect(preceding).not.toMatch(/mode\s*===\s*'master'/);
  });
});

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

  /**
   * Codex 九轮 P2：只把容器归进低权重 slice 不构成保护——1000:100 这个比要成立，
   * 控制面进程自己也得跑在带 CPUWeight 的 systemd 单元里。executor 是 `nohup node`
   * 起的，没有那份单元；此时报 weightManaged 就是谎报，healthz 会说「已接管」而
   * 实际上 executor API 仍是默认权重。归组保留，状态如实。
   */
  it('控制面进程未被提权时（executor 用 nohup 起）：容器仍归组，但 weightManaged 为假', () => {
    const s = planWorkloadCgroup(DEFAULT_WORKLOAD_SLICE, 'systemd', { controlPlanePrioritized: false });
    expect(s).toMatchObject({ enabled: true, parent: DEFAULT_WORKLOAD_SLICE, weightManaged: false });
    expect(s.reason).toContain('控制面未受保护');
    __setWorkloadCgroupForTest(s);
    // 归组照旧下发，只是别再宣称有权重保护
    expect(workloadCgroupFlags()).toEqual([`--cgroup-parent '${DEFAULT_WORKLOAD_SLICE}'`]);
  });

  /**
   * Codex 十轮 P2：按运行模式猜「有没有被提权」仍然窄——executor 接入、后台或前台直接
   * 跑 node，几条路径都不经过控制面 systemd 单元。判据改成量真实的 cgroup 归属。
   */
  it('isControlPlanePrioritized：只有落在控制面单元下才算被提权', () => {
    // cgroup v2
    expect(isControlPlanePrioritized('0::/system.slice/cds-master.service\n')).toBe(true);
    expect(isControlPlanePrioritized('0::/system.slice/cds-forwarder.service\n')).toBe(true);
    // 后台 / 前台直接起的 node：落在用户会话或根下
    expect(isControlPlanePrioritized('0::/user.slice/user-0.slice/session-3.scope\n')).toBe(false);
    expect(isControlPlanePrioritized('0::/\n')).toBe(false);
    // 别的服务单元不算
    expect(isControlPlanePrioritized('0::/system.slice/docker.service\n')).toBe(false);
    // cgroup v1 多行格式
    expect(isControlPlanePrioritized('9:name=systemd:/system.slice/cds-master.service\n8:pids:/\n')).toBe(true);
    expect(isControlPlanePrioritized('9:name=systemd:/\n8:pids:/\n')).toBe(false);
    // 读不到一律按未提权
    expect(isControlPlanePrioritized(null)).toBe(false);
    expect(isControlPlanePrioritized('')).toBe(false);
  });

  it('探测时按真实 cgroup 归属判提权（沙箱不在控制面单元下 → 如实报未受保护）', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker info/, () => ({ stdout: 'systemd\n', stderr: '', exitCode: 0 }));
    const s = await resolveWorkloadCgroup(shell, {});
    expect(s.enabled).toBe(true);
    // 这个进程不是 cds-master.service 起的，所以必须报未提权——而不是因为 CDS_MODE 是什么
    expect(s.weightManaged).toBe(false);
    expect(s.reason).toContain('控制面未受保护');
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
